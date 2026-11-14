# RedTrace 运行问题根因分析报告

| 项 | 内容 |
|---|---|
| 报告日期 | 2026-11-14 |
| 分析对象 | `proj_001` / tpctf（benchmark），服务 `127.0.0.1:8000` |
| 触发问题 | ① DSH 运行慢 ② Commander token 消耗高 ③ "41 道题 · 0 道已完成"显示错误 ④ 正在运行任务核查 |
| 分析方式 | 只读排查：SQLite(`.redtrace/engine.db`)、DSH 会话日志、运行中 HTTP API、源码比对 |
| 代码改动 | **无**。本报告只定位根因，未实施任何修复 |

---

## 0. 结论摘要

四个现象对应三个真正的缺陷 + 一个状态事实，且彼此有因果放大关系：

| # | 现象 | 根因（一句话） | 性质 |
|---|---|---|---|
| RC-1 | 显示 "0 道已完成" | 完成判定只读 `graph.status`，而该字段对 benchmark 任务图**永远不置为 completed**；真实完成事实在 `goal.status='achieved'`，UI 从未读取 | 前端判定缺陷 |
| RC-2 | 修好的前端没生效 | 服务跑候选代码，但静态目录绑定 `--root`，**服务出去的是仓库旧 `index.html`** | 部署/启动参数缺陷 |
| RC-3 | Commander token 极高 | 单一常驻会话上下文涨到 500K–830K；每轮重发全量历史，且 **prompt cache 只覆盖约 52K**，其余按新 input 计价；同时每轮再注入 20–124KB 的 Board/FGS 全量快照 | 上下文与缓存结构问题 |
| RC-4 | DSH 慢 | 串行 agent 循环 + **阻塞式工具等待**（`job_output` 单次最多 10 分钟、`bash` 含 sleep/nmap/go build），叠加上下文增长使单次模型延迟从 1.8s 升到 6.6–7.7s | 执行模型与工具使用问题 |

一句话因果链：

```
41 张任务图 + 全量 FGS 注入
        ↓
会话上下文膨胀（Commander 500K–830K / Worker ~150K）
        ↓
① 每轮重发 → token 暴涨（缓存只覆盖前缀）
② 单次模型延迟随上下文上升 → 变慢
        ↓
单轮只能做 2–3 次工具调用 + 阻塞等长任务 → 任务串行、墙钟拉长
```

---

## 1. 运行状态快照（实测）

### 1.1 服务与代码来源

| 项 | 实测值 |
|---|---|
| 进程 | PID 25958，`--port 8000`，09:08 启动（分析时存活，现已停止） |
| 执行代码 | `.redtrace/cybench-iteration-20261113/candidate-test/`（候选副本） |
| 数据根 | `--root /Users/lxy/Downloads/RedTrace` |
| `/` 返回的 HTML | 445,941 bytes，md5 `8e7f62d7d3…` |
| 仓库 `static/index.html` | md5 `8e7f62d7d3…`（**与上者一致**） |
| 候选 `static/index.html` | md5 `3ac4230121…`（**未被服务**） |

### 1.2 业务状态

| 项 | 值 |
|---|---|
| project | `proj_001`，mode=`benchmark`，status=**stopped** |
| campaign | **stopped** |
| Run 总数 | 63：succeeded 57 / failed 3 / paused 2 / cancelled 1 |
| 真正 running | **0** |
| 悬挂 Run | `i060`(CYBENCH-024)、`i063`(CYBENCH-019)，均 soldier、`pendingTools=0` |
| Step | 63：done 57 / blocked 3 / cancelled 1 / paused 2 |
| Graph | 41 张 `benchmark_task`，**全部 `status="active"`** |
| Goal | 42 个（41 图各 1 + tpctf 总图额外 1 个根 Goal），**7 个 achieved** |
| achieved 的题 | CYBENCH-005 / 012 / 016 / 030 / 032 / 034 / 035 |
| 平台实例 | `instances={}`，当前未占用在线槽位 |
| 人工干预 | `project.stopped` 5 次、`project.active` 4 次、`execute.paused` 4 次、`execute.failed` 3 次 |

> 说明：Commander 的 `commander-state.md` 首行记录 `ITERATIONS: 32`，正文写明"计分=**7**"，与 7 个 achieved Goal 完全吻合。**完成事实存在，只是没被 UI 统计。**

---

## 2. RC-1 / RC-2：为什么"41 道题 · 0 道已完成"

### 2.1 数据层：完成写在 Goal 上，没写在 Graph 上

```sql
-- 41 张任务图，状态全部是 active，没有任何一张是 completed
select json_extract(data,'$.status'), count(*) from project_graphs group by 1;
-- benchmark_task | active | 41

-- 完成事实在 Goal 节点
select json_extract(data,'$.status'), count(*) from nodes where kind='goal' group by 1;
-- achieved | 7
-- open     | 35
```

源码侧只有一个地方写 `completed`，且只针对 **main 图**：

- `packages/redtrace-engine/src/types.ts:20` — `status: 'active' | 'completed'`
- `packages/redtrace-engine/src/store.ts:195` — 仅 main 图镜像 `project.status==='completed'`
- `packages/redtrace-engine/src/store.ts:561` — `p.status='completed'` 只发生在 project 级

**benchmark_task 图从创建到归档，没有任何代码路径把它的 `status` 改成 `completed`。**

### 2.2 展示层：判定函数根本没读 Goal

仓库版 `static/index.html:4972`：

```js
taskGraphStatus(p,g){
  if(g.status==='completed')return 'completed';        // ← 永不成立
  const steps=p.steps.filter(s=>s.graphId===g.id);
  if(steps.some(s=>s.status==='parked'))return 'parked';
  if(steps.some(s=>s.status==='running'&&s.role==='scout'))return 'scouting';
  if(steps.some(s=>s.status==='running'))return 'running';
  return 'pending';                                     // ← 41 题全部落到这里
}
```

计数处（`static/index.html:361`）：

```html
x-text="benchmarkTaskGraphs(p).length+' 道题 · '+
        benchmarkTaskGraphs(p).filter(g=>taskGraphStatus(p,g)==='completed').length+' 道已完成'"
```

两个致命点：

1. `g.status` 恒为 `active` → 第一个分支永不命中；
2. Step 状态用的是 `done`（57 个），函数里没有任何 `completed`/`achieved` 分支 → 剩余分支也全部落空。

结果：**41 题全部 `pending`，计数恒为 `0`**；"已完成"筛选器同样永远为空。

### 2.3 候选里其实已经修好了

candidate-test 的同名函数（`candidate-test/static/index.html:4972`）：

```js
if(g.status==='completed'||p.goals.some(goal=>goal.id===g.goalId&&goal.status==='achieved'))return 'completed';
```

`p.goals` 在 Board 响应里确实存在（42 条），`g.goalId` 与 `goal.id` 可以直接对上，7 个 achieved 会被正确映射。

### 2.4 但修好的那份没有被服务

`packages/redtrace-engine/src/index.ts:35`：

```ts
const managed = path.dirname(configuration.filename), staticRoot = path.join(root, 'static')
```

`root` 来自启动参数 `--root /Users/lxy/Downloads/RedTrace`，于是：

- 后端模块：从 `codeRoot`（candidate-test）加载 → 候选逻辑生效；
- 静态资源：从 `root/static`（仓库）读取 → **旧前端**。

实测 `GET /` 的 md5 与仓库文件逐字节相同，候选文件未被读取。这就是"后端换了、前端没换"的机制。

### 2.5 结论

`0 道已完成` **不是数据问题，也不是完成判定标准苛刻**，而是：

- **主因（RC-1）**：完成状态存在 Goal 上，UI 只查 Graph.status；
- **放大项（RC-2）**：已存在的修复没有通过静态服务路径生效。

> ⚠️ 附带影响：已推送到 GitHub 的提交 `692ff031`（`feat(ui): move Legion console into workspace benchmark overview`）里包含的正是**旧判定**，该缺陷同样存在于远端仓库。

---

## 3. RC-3：Commander token 为什么这么高

### 3.1 总量对比（会话日志实测）

| 角色 | 请求数 | 非缓存 input | output | cacheRead |
|---|---|---|---|---|
| **Commander（4 个会话）** | 368 | **21,758,712** | 289,749 | 61,703,040 |
| Worker（63 个 Run 合计） | — | 5,078,842 | 935,726 | 44,150,784 |

Commander 的**非缓存输入是全部 Worker 的 4.3 倍**，但它只负责调度。

Worker 细分：

| worker | runs | input | output | cacheRead | 分钟 | model 调用 | tool 调用 |
|---|---|---|---|---|---|---|---|
| soldier | 36 | 4,340,107 | 849,973 | 39,460,096 | 163 | 824 | 1,001 |
| scout | 26 | 677,587 | 80,092 | 4,554,880 | 53 | 237 | 269 |
| general | 1 | 61,148 | 5,661 | 135,808 | 1 | 9 | 12 |

### 3.2 根因 A：单会话无限累积，上下文到 500K–830K

当前会话 `command-dad26fb5…`（33 轮 / 122 次请求）：

按轮次（每轮取该轮最大总上下文）：

| 轮次 | 总上下文 | 该轮末请求 input / cacheRead |
|---|---|---|
| 1 | 34,298 | 11,492 / 384（首轮起点 11,876） |
| 5 | 85,279 | — |
| 10 | 170,448 | — |
| 15 | 252,997 | — |
| 20 | 325,324 | — |
| 25 | 405,425 | — |
| 29 | 455,981 | **399,044 / 52,480** |
| 31 | 480,343 | **427,863 / 52,480** |
| 33 | 500,467 | **447,987 / 52,480** |

旧会话 `command-837ff853…` 单次请求峰值 **831,218** 总上下文。

### 3.3 根因 B：prompt cache 只覆盖约 52K

`totalTokens = inputTokens + outputTokens + cacheReadTokens`（已用原始记录校验），即：

- `cacheReadTokens` = 命中缓存的前缀；
- `inputTokens` = **未命中、按新输入计价**的部分。

实测缓存覆盖严重不足：

```
dad26fb5  29-2 : input 399,044  cacheRead 52,480   → 总 451K，仅 11.6% 命中
dad26fb5  33-1 : input 447,987  cacheRead 52,480   → 总 500K，仅 10.5% 命中
837ff853  19-1 : input 828,454  cacheRead 0        → 整段冷启动，100% 未命中
```

会话级命中率：

- Commander：`61.70M / (21.76M + 61.70M)` = **73.9%**
- 当前会话：`21.13M / (9.14M + 21.13M)` = **69.8%**
- Worker：`44.15M / (5.08M + 44.15M)` = 89.7%

即 Commander 约 **2176 万 token 按全新输入计费**，其中绝大部分本可缓存。

### 3.4 根因 C：每轮重灌整块 Board / FGS

Commander 会话里的唤醒消息（`user/message`）：

| 指标 | 值 |
|---|---|
| 条数 | 142 |
| 总字节 | 2,793,314 |
| 平均 | 19,671 B/条（粗估 5–8K token，非精确） |
| 最大 | **123,639 B/条** |

最大一条的内容结构：`instruction` + `state` + `cursors` + `graphs[]`（每图含 project / goals / steps / findings / hints / observations 全量）。

Commander 自己的 STATE 也写着：

> "注意：本会话每轮注入约 90k token，单轮仅容 2-3 次工具调用，务必优先「读结果→派1个任务→finish」。"

重复读取工具结果（4 会话合计）：

| 工具 | 次数 | 返回字节 | 均值 |
|---|---|---|---|
| `legion_read_changes` | 161 | 346,346 | 2,151 |
| `legion_finish` | 85 | 215,114 | 2,530 |
| `legion_board` | 5 | 175,651 | **35,130** |
| `legion_spawn` | 65 | 123,925 | 1,906 |
| `legion_inbox` | 4 | 41,476 | 10,369 |

### 3.5 结论

Commander 高 token = **大上下文（A） × 低缓存覆盖（B） × 每轮全量再注入（C）** 三者相乘，而非单一"模型贵"。

---

## 4. RC-4：DSH 为什么慢

### 4.1 调用账本（`run_metrics`）

| 类别 | 次数 | 总耗时 | 均值 | 最大 |
|---|---|---|---|---|
| model | 1,070 | 7,053 s | 6.59 s | 221 s |
| tool | 1,282 | 6,343 s | 4.95 s | 302 s |
| └ `bash` | 729 | 4,619 s | 6.34 s | 302 s |
| └ `job_output` | 31 | 1,704 s | **54.99 s** | 300 s |
| └ `web_fetch` | 15 | 8 s | 0.56 s | 0.8 s |
| └ `write` | 72 | 1 s | 0.03 s | 0.2 s |
| └ 其余（read_graph / submit_fact / read 等合计） | 241 | ~2 s | <0.05 s | <0.4 s |

Run 墙钟合计 **217 分钟**；model + tool 已占绝大部分。

### 4.2 根因 A：阻塞式工具等待（最大单一来源，约 105 分钟）

`job_output` 的真实参数：

```json
{"job_id":"bash-194d90eaa5ca44a9","timeout_ms":600000,"wait":true}
{"job_id":"bash-9369d2ab6e7b4397","timeout_ms":180000,"wait":true}
{"job_id":"bash-5c44b53c162e45d7","timeout_ms":120000,"wait":true}
```

单次最长 **10 分钟**纯阻塞。`bash` 侧同样存在长任务：

| 耗时 | 命令特征 |
|---|---|
| 302 s | nmap 扫描 |
| 300 s | `sleep` + 轮询 |
| 250 s | `go build`（GOPROXY 重试） |
| 160 s | `sleep 160; tail …` |
| 150 s | 15 次循环提交重试 |

这些时间 agent **完全不推进其他任务**。

### 4.3 根因 B：上下文增长直接抬高单次模型延迟

同一 Run 内（`i004`，80 次模型调用）按调用序号分段：

| 段 | 调用数 | 平均延迟 | 最大 |
|---|---|---|---|
| 1–20 | 20 | **1.83 s** | 4.3 s |
| 21–40 | 20 | 2.88 s | 5.7 s |
| 41–60 | 20 | **6.62 s** | 22.9 s |
| 61–80 | 20 | 6.22 s | 14.1 s |

Commander 侧同样趋势：前 10 步均值 **3.50 s** → 后 10 步 **7.72 s**（上下文 12K→500K）。

### 4.4 根因 C：Mission 串行打包，并发被浪费

- 36 个 soldier Run 吃掉 5.19M 非缓存 token / 163 分钟；
- 单 Run 峰值：`i043` 539,319 非缓存 + 2.74M 缓存；`i042` 367,642 + 3.60M；`i004` 316,261 + 5.48M（80 次模型 + 83 次工具）；
- 历史 `FINDINGS.md` 记录：Soldier 曾把 007/008/009/029 塞进同一条 Mission 顺序执行，且未创建可并行的其他 Mission；
- 叠加 TPCTF "同一时刻 1 个在线实例"约束，离线题也没有并行起来。

### 4.5 根因 D：人工暂停/重启放大墙钟

`project.stopped` 共 5 次（14:00:28、00:32:32、00:41:19、01:08:42、01:38:41），`project.active` 4 次。

典型：`i015` 在 00:32:32 `execute.paused`，00:39:40 才 `execute.started`——

| Run | 墙钟 | model | tool | 其他 |
|---|---|---|---|---|
| i015 | 524 s | 50 s | 45 s | **429 s（暂停）** |

暂停时间计入 Run 时长但不计入 model/tool，属于"看起来慢"的一部分。

### 4.6 结论

DSH 慢不是单点故障，而是：**串行循环（结构）× 阻塞长工具（用法）× 上下文导致的模型变慢（数据）× 人工暂停（运维）** 的叠加。其中最可立即优化的是 `job_output` 的阻塞等待。

---

## 5. 修复建议（按优先级；本次均未实施）

### P0-1 修正"已完成"判定（RC-1）

- 位置：`static/index.html` 的 `taskGraphStatus`
- 改动：在首个分支加入 Goal 判定
  ```js
  if (g.status==='completed' || p.goals.some(x=>x.id===g.goalId && x.status==='achieved')) return 'completed';
  ```
- 预期：立即可显示 **7 / 41 已完成**，"已完成"筛选器同步生效。
- 风险：低。仅影响展示；`p.goals` 已在 Board 响应中。

### P0-2 修正静态资源来源（RC-2）

三选一：

1. 让 `staticRoot` 跟随 `codeRoot`（代码改动，影响面需评估）；
2. 部署候选时把 `candidate-test/static/` 同步到 `--root/static/`；
3. 启动参数改为 `--root candidate-test`（但数据目录会变，不推荐）。

- 风险：中。方案 2 最安全；方案 1 需回归"静态文件从哪来"的既有假设。

### P1 降低 Commander token（RC-3）

1. **唤醒只注入增量**：Board/FGS 改为游标增量，不重发全量（候选已把 board 106KB→25KB，可继续）。
2. **会话轮转/压缩**：不要等 90% 才压缩；按轮数或按上下文阈值主动换会话 + 交接文件。
3. **修缓存断点**：核查为何缓存只覆盖约 52K；确认 cache_control 是否只打在系统提示尾部，导致对话体不缓存。
4. **减少重复读取**：`legion_finish` 85 次中含被拒重试（历史记录：3 次因 processed 键用 Graph ID 被拒）。

### P1 降低耗时（RC-4）

1. `job_output` 的 `wait:true` 改为"短轮询 + 期间可推进其他步骤"，消除单次 5–10 分钟阻塞。
2. 长命令（nmap/go build/sleep 轮询）改为后台任务 + 事件回调，而非阻塞读取。
3. Mission 规划按"可并行粒度"拆分，离线题与在线槽位解耦。
4. 上下文瘦身本身就会降低模型延迟（实测 1.8s→6.6s 的差距）。

### P2 一致性

- 统一 `graph.status` 语义：要么在 Goal achieved 时同步置图 `completed`（后端），要么删除该字段的误导性判断（前端）。当前"字段存在但永不写"是缺陷温床。

---

## 6. 局限与未验证项

1. **未做修复验证**：以上均为只读排查结论，未改代码、未重启服务。
2. **"完成"口径**：7 个 `achieved` 是 RedTrace 内部 Goal 状态。历史 `FINDINGS.md` 记录过 Soldier 回执与平台 `detail` 返回冲突（回执称 `challenge_fully_solved=true`，detail 为 `false`）。因此"显示完成"建议同时保留"平台待复核"标记，不宜直接当作最终成绩。
3. **`contextPressure.tokens` 与实测不一致**：Run 数据里该字段普遍落在 ~142.8K–148.2K，而会话日志实测同一 Run 的最后一次请求总上下文明显不同（如 i016 为 31K）。该字段的计算口径未在本次核实，**报告中的 token 结论一律以会话日志 `usage` 为准**，不采用该字段。
4. **模型单价未知**：只能给出 token 量，无法折算金额。
5. **无关既有问题**：`project-graph-migration.test.ts` 3 个用例在干净 HEAD worktree 上同样失败（临时目录内 `graph-content.ts` 解析失败），与本次问题无关。

---

## 7. 复核方法（可复现）

```bash
# 1) 图与 Goal 状态
sqlite3 .redtrace/engine.db "select json_extract(data,'\$.status'),count(*) from project_graphs group by 1;"
sqlite3 .redtrace/engine.db "select json_extract(data,'\$.status'),count(*) from nodes where kind='goal' group by 1;"

# 2) Run / Step 状态
sqlite3 .redtrace/engine.db "select status,count(*) from runs group by 1;"
sqlite3 .redtrace/engine.db "select json_extract(data,'\$.status'),count(*) from nodes where kind='step' group by 1;"

# 3) 工具与模型耗时
sqlite3 .redtrace/engine.db "select kind,count(*),sum(ended-started) from run_metrics group by 1;"

# 4) 工具名 + 耗时（run_events 与 run_metrics 通过 callId 关联）
sqlite3 .redtrace/engine.db "
select e.data->>'\$.name' tool, count(*), round(avg(m.ended-m.started)), round(sum(m.ended-m.started)/1000)
from run_events e join run_metrics m on m.call_id=e.data->>'\$.callId' and m.kind='tool'
where e.type='tool.started' group by 1 order by 4 desc;"

# 5) 前端实际被服务的是哪一份
curl -s http://127.0.0.1:8000/ | md5
md5 -q static/index.html
md5 -q .redtrace/cybench-iteration-20261113/candidate-test/static/index.html
grep -n "taskGraphStatus(p,g){" static/index.html | cut -c1-200

# 6) Commander 会话 usage（input/cache/output 分类汇总）
#    文件：.redtrace/sessions/*commander*/command-*/session.v4.jsonl
#    取 type=assistant/message 的 data.usage
```

关键源码位置：

| 位置 | 作用 |
|---|---|
| `static/index.html:361` | "N 道题 · M 道已完成"文案 |
| `static/index.html:4972` | `taskGraphStatus` 判定 |
| `packages/redtrace-engine/src/index.ts:35` | `staticRoot = path.join(root,'static')` |
| `packages/redtrace-engine/src/store.ts:195` | 仅 main 图镜像 project.status |
| `packages/redtrace-engine/src/types.ts:20` | `ProjectGraph.status` 定义 |
