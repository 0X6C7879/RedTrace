# RedTrace 提示词迁移到 Skill 与 Cairn 中文模板回退完整方案

> 目标：在**不削弱 RedTrace 已有能力**的前提下，将当前长期注入到 Worker 的 Blackboard、Workspace、Skill Runtime、Resource、WebShell、C2、Web 调研、工具安装、Context Harness 等控制说明从主任务 Prompt 中移出，使 `bootstrap / reason / explore / *_conclude` 恢复到接近 Cairn 的中文精简模板；仅在实际需要时按需加载 Skill，机械性不变量由 Runtime / Harness / Control Plane 强制。
>
> 核心原则：**Prompt 只负责当前任务认知；Skill 负责按需专业知识；Runtime 负责协议与状态机。**

---

# 1. 背景与现状

当前 RedTrace 与 Cairn 的最大差异，并不只是 `reason.md`、`explore.md` 等模板内容，而是 RedTrace 在模板渲染后继续追加大量固定运行协议。

Cairn 的 Prompt 拼装基本是：

```text
模板
+ 当前任务变量
= 最终 Prompt
```

RedTrace 当前更接近：

```text
输出语言
+ 阶段模板
+ Blackboard 协议
+ Workspace 协议
+ Web 调研协议
+ 已知漏洞利用协议
+ 工具安装协议
+ Project Hints
+ WebShell/C2 协议
+ 自动执行规则
+ Skill Runtime Policy
+ Context Harness
+ Final output contract
= 最终 Prompt
```

这导致两个问题：

1. **常驻输入 Token 增长**：这些协议会在大量 Explore 调用中反复发送。
2. **Instruction Dilution**：模型真正应该关注的 `Current Intent` 被大量基础设施说明稀释。

当前涉及的核心源码位置：

```text
redtrace/src/redtrace/dispatcher/prompts/default/
├── bootstrap.md
├── bootstrap_conclude.md
├── explore.md
├── explore_conclude.md
└── reason.md

redtrace/src/redtrace/dispatcher/prompting.py
redtrace/src/redtrace/skill_runtime.py
redtrace/src/redtrace/dispatcher/tasks/bootstrap.py
redtrace/src/redtrace/dispatcher/tasks/reason.py
redtrace/src/redtrace/dispatcher/tasks/explore.py
```

现有 Skill 根目录：

```text
skills/
```

现有 Skill 采用标准 `SKILL.md` + frontmatter 结构，例如：

```yaml
---
name: brave-search
description: ...
---
```

因此无需重新设计 Skill 文件格式。

---

# 2. 改造目标

## 2.1 必须达到的目标

改造后：

```text
Bootstrap Prompt
≈ Cairn 中文版 Bootstrap

Reason Prompt
≈ Cairn 中文版 Reason
+ RedTrace GraphPatch 最小扩展

Explore Prompt
≈ Cairn 中文版 Explore

Explore Conclude
≈ Cairn 中文版 Explore Conclude

Bootstrap Conclude
≈ Cairn 中文版 Bootstrap Conclude
```

普通 Explore 的常驻上下文中不得再出现以下长说明：

```text
Blackboard 使用手册
Workspace 使用手册
WebShell/C2 命令手册
Resource 生命周期手册
Skill Routing/Recall/Learning 手册
Context Harness 使用手册
工具安装手册
Web 调研顺序手册
```

## 2.2 必须保留的 RedTrace 能力

不能因为回退 Prompt 而丢失：

- Graph / Fact / Intent 黑板
- Reason GraphPatch
- `create/drop/reprioritize/supersede/complete`
- Blackboard 增量通知
- Observation
- Resource
- Credential Secret 管理
- WebShell 管理
- C2 Listener / Session / Payload
- 多 Worker Workspace
- Skill
- Skill Recall
- Skill 自进化
- Learning Checkpoint
- Context Harness
- RTK
- Agent 原生 Web / Brave Search
- Worker 并行能力
- 输出 Contract 校验
- Session conclude / recovery

---

# 3. 第一性原理：什么应放 Prompt、什么应放 Skill、什么应放 Runtime

判断标准只有三个。

## 3.1 Prompt：当前任务必须立即理解的内容

仅保留：

- 当前阶段是什么；
- 当前任务是什么；
- 当前 Intent 是什么；
- 当前 Graph/Origin/Goal 在哪里；
- 最终应该返回什么结构。

Prompt 不承担基础设施手册。

## 3.2 Skill：只有需要时才加载的“方法与知识”

适合放 Skill：

- Web 调研策略；
- 已知漏洞 PoC/EXP 调研流程；
- WebShell 操作方法；
- C2 使用方法；
- 高级 Blackboard 查询方法；
- Resource 高级操作方法；
- 工具 Bootstrap 方法；
- Skill 自进化的判断方法。

这些内容在不相关任务中应占 **0 常驻 Token**。

## 3.3 Runtime / Harness / Control Plane：机械不变量

必须由程序保证：

- 工作目录；
- Blackboard revision；
- Blackboard 增量事件；
- Resource 状态；
- Credential Secret 不泄漏；
- Session/Listener 生命周期；
- 输出 JSON Contract；
- GraphPatch 合法性；
- Resource ID 校验；
- Skill load audit；
- Recall 触发；
- Learning 触发；
- Context 大输出落盘；
- Worker / Intent 状态一致性。

原则：

```text
模型负责“判断”
程序负责“保证”
```

---

# 4. 当前控制协议迁移总表

| 当前长期 Prompt 内容 | 新归属 | 是否常驻 Prompt | 说明 |
|---|---|---:|---|
| 输出语言 | 模板本身 | 否 | 模板直接写中文 |
| Final output contract | 模板 + Validator | 否 | 模板只保留最小 schema |
| Blackboard revision/snapshot/changes | Runtime | 否 | 由 BlackboardInbox 推送 |
| Blackboard source/path/context 高级操作 | `redtrace-blackboard` Skill | 否 | 需要跨 Worker 溯源时加载 |
| Workspace 根目录 | Runtime cwd/env | 否 | Worker 默认工作目录即 Workspace |
| Workspace 文件协作/锁 | `redtrace-workspace` Skill + Resource Lock | 否 | 发生共享文件写冲突时加载 |
| Web 调研顺序 | `web-research` Skill | 否 | 需要互联网调研时加载 |
| 已知漏洞优先 PoC/EXP | `exploit-research` Skill | 否 | 出现 fingerprint/CVE/版本线索时加载 |
| 工具安装流程 | `tool-bootstrap` Skill | 否 | 工具缺失时加载 |
| Project Hints | Graph / 当前任务上下文 | 否追加 | 不重复注入 |
| Observation | Runtime + Blackboard CLI | 否 | 由事件/工具提供 |
| Resource 基础状态 | Control Plane | 否 | 程序管理 |
| Resource 高级操作 | `redtrace-resource` Skill | 否 | 需要手工操作 Resource 时加载 |
| WebShell 命令流程 | `redtrace-webshell` Skill | 否 | 获取或操作 WebShell 时加载 |
| C2 Listener/Payload/Session | `redtrace-c2` Skill | 否 | reverse/bind/C2 时加载 |
| Credential Secret 规则 | Control Plane | 否 | Secret Store 强制 |
| Skill Routing | Runtime / Agent 原生 Skill discovery | 否 | 不再写进 Prompt |
| Skill Recall | Skill loader hook | 否 | load 后自动 recall |
| Learning 触发 | Runtime | 否 | 任务结束自动触发 |
| Learning 判断 | `skill-evolution` Skill | 否 | 仅 Learning Session 加载 |
| Context Harness | Runtime | 否 | 透明处理大输出 |
| Windows shell 适配 | Worker Driver | 否 | Driver 处理 |
| 自动继续执行 | Worker/Task Runtime | 否 | 不靠自然语言反复提醒 |

---

# 5. 新 Skill 设计

建议新增或整理为以下跨任务 Skill。

```text
skills/
├── redtrace-blackboard/
│   └── SKILL.md
├── redtrace-workspace/
│   └── SKILL.md
├── redtrace-resource/
│   └── SKILL.md
├── redtrace-webshell/
│   └── SKILL.md
├── redtrace-c2/
│   └── SKILL.md
├── web-research/
│   └── SKILL.md
├── exploit-research/
│   └── SKILL.md
├── tool-bootstrap/
│   └── SKILL.md
└── skill-evolution/
    └── SKILL.md
```

注意：

- 不建议把所有 RedTrace 控制协议做成一个超大 `redtrace-runtime` Skill。
- 超大 Skill 会重新造成“加载一次就把所有无关规则塞入上下文”。
- 采用多个小 Skill，才能真正按需加载。

---

# 6. 各 Skill 的职责边界

## 6.1 `redtrace-blackboard`

只负责高级查询方法，不负责 revision 轮询。

建议内容：

```yaml
---
name: redtrace-blackboard
description: Query RedTrace Blackboard history, source context, graph paths, and cross-worker evidence when the current task needs information beyond the provided graph snapshot.
---
```

包含：

- `snapshot`
- `changes`
- `node`
- `context`
- `source`
- `path`
- 什么情况下查 source；
- 什么情况下查 path；
- 不重复读取已经确认的信息。

不包含：

- 固定 heartbeat 说明；
- 每个任务都必须读 notice 的说明；
- revision 轮询策略。

这些交给 Runtime。

## 6.2 `redtrace-workspace`

只在多 Worker 共享文件需要协作时加载。

包含：

- Workspace 文件约定；
- 文件 Resource；
- lock/unlock；
- 423 冲突处理；
- 只读无需锁；
- 独立输出文件策略。

Runtime 默认：

```text
cwd = $REDTRACE_WORKSPACE
```

并把临时目录尽量指向 Workspace 内：

```text
REDTRACE_TMPDIR=$REDTRACE_WORKSPACE/.tmp
TMPDIR=$REDTRACE_WORKSPACE/.tmp
TEMP=$REDTRACE_WORKSPACE/.tmp
TMP=$REDTRACE_WORKSPACE/.tmp
```

注意：Local 模式下不要修改 `HOME`，否则可能破坏 Claude/Codex/Pi 原生配置。

## 6.3 `redtrace-resource`

只负责模型确实需要操作 Resource 时的命令方法。

包含：

- `snapshot`
- `list`
- `changes`
- register
- lock
- unlock
- credential_ref
- artifact/file Resource
- Resource 与 Fact 的区别。

Runtime 保证：

```text
Resource 是运行状态
Fact 是黑板结论
```

模型不需要每轮重读这个定义。

## 6.4 `redtrace-webshell`

从当前 Explore 常驻 Prompt 中完整迁出 WebShell 手册。

包含：

- WebShell 注册；
- GET/POST；
- protocol；
- Resource ID；
- `webshell-create`
- `redtrace-resource run --wait`
- WebShell 复用；
- 已存在 WebShell 优先复用；
- WebShell 管理页面同步要求。

触发条件：

```text
webshell
HTTP RCE 持久通道
命令执行入口需要复用
```

## 6.5 `redtrace-c2`

迁移当前 Prompt 中全部 C2 工作流。

包含：

- listener-create
- tcp reverse
- tcp bind
- session-register
- payload-oneliner
- payload-build
- payload-import
- payload-external
- external C2
- MSF / Sliver / Cobalt Strike adapter
- Beacon / Meterpreter / 普通 Shell 的类型语义
- reverse session 与 listener 的绑定关系
- bind connector
- Session 复用。

触发条件：

```text
reverse shell
bind shell
listener
C2
beacon
meterpreter
SSH / Evil-WinRM / PsExec / WMI 需要纳入 Session 管理
```

关键原则：

**操作方法放 Skill，资源存在性和 ID 校验放 Runtime。**

## 6.6 `web-research`

用于替代当前固定的“Web 调研顺序”。

包含：

- Claude/Codex 原生 Web 优先；
- Brave Search fallback；
- Pi 使用 Brave Search；
- 保留 URL；
- 同一 query 不重复换 provider；
- 出现新 fingerprint/version/error/knowledge gap 时重新调研。

如果现有 `brave-search` Skill 已经承担“怎么使用 Brave Search”，则：

```text
web-research = 调研策略
brave-search = 搜索工具使用
```

不要合并成一个大 Skill。

## 6.7 `exploit-research`

迁移：

```text
发现 product/version/banner/hash fingerprint
→ 先看已有 Fact
→ 实时 Web query
→ 获取特定 PoC/EXP
→ 验证适用性
→ 最小 PoC
→ EXP
→ 全部合理候选失败后再做自定义漏洞发现
```

禁止把整套规则常驻所有 Explore。

只有出现已知产品/版本/CVE/漏洞候选时加载。

## 6.8 `tool-bootstrap`

迁移工具缺失时的安装说明。

包含：

- 先找已安装等价工具；
- 核对 OS / architecture；
- 官方来源；
- 固定版本；
- 非交互；
- `$REDTRACE_TOOLS_DIR`
- `$REDTRACE_TOOLS_BIN`
- checksum；
- `--version`
- smoke check；
- 只允许一个有依据的 fallback。

Runtime 只负责提供：

```text
$REDTRACE_TOOLS_DIR
$REDTRACE_TOOLS_BIN
PATH
```

---

# 7. Skill 自进化统一为 `skill-evolution`

## 7.1 当前问题

当前 Skill Runtime Policy 会长期告诉 Worker：

- 如何选 Skill；
- 最多加载几个；
- load 后要 recall；
- Worker 不得直接修改 Skill；
- Learning Checkpoint 才能 learn。

这些属于系统控制，不应该常驻任务 Prompt。

## 7.2 新架构

Learning 不再创建独立 Session，也不额外占用 Claude/Codex/Pi 等 Agent 工具的会话或 Worker 槽位。

正确流程为：

```text
任务开始
   ↓
Runtime / Agent 原生 Skill discovery
   ↓
加载专业 Skill
   ↓
Skill Loader Hook 自动 recall
   ↓
执行任务
   ↓
当前对话任务已经完成，准备结束当前 Agent 会话
   ↓
Runtime 触发 skill-evolution
   ↓
在当前会话的结束阶段按需加载 skill-evolution
   ↓
由当前模型自行判断：
“本次任务是否产生了值得积累的可复用经验？”
   ↓
   ├─ 否 → 不调用 learn，直接结束当前会话
   └─ 是 → redtrace-skill learn <本次实际使用过的专业 Skill>
                  ↓
              结束当前会话
```

Runtime 只负责保证“任务结束时触发一次 Skill 自进化检查”，不替模型判断是否应该学习。

`skill-evolution` 负责让当前模型基于刚刚完成并已经验证的任务结果，自主决定：

- 是否存在值得积累的新经验；
- 是否应该跳过学习；
- 应更新哪个本次实际使用过的专业 Skill；
- 如何对经验做泛化、去项目化和证据约束。

因此 Learning 是**当前任务会话的结束钩子（end-of-task hook）**，而不是另起一次 Agent 对话。

## 7.3 `skill-evolution` 只负责智能判断

建议 frontmatter：

```yaml
---
name: skill-evolution
description: Review verified task outcomes and evolve only the professional Skills actually used in the task by extracting reusable, non-project-specific, evidence-backed experience.
---
```

负责判断：

- 本次是否真的产生新经验；
- 是否已经被现有 learned 经验覆盖；
- 是否项目特有；
- 是否经过验证；
- 应归入哪个实际加载过的专业 Skill；
- 如何泛化；
- 是否与旧经验冲突；
- 是否应 reinforce / supersede；
- 如何脱敏；
- evidence 是否充分。

## 7.4 不放进 `skill-evolution` 的内容

以下必须由 Runtime 强制：

- 在当前对话任务结束、正式释放 Agent 会话之前触发一次 Learning Checkpoint；
- 不创建新的 Agent Session；
- 不额外占用 Worker 槽位；
- 哪些 Skill 本次真的加载过；
- Recall 是否执行；
- `learn` 是否允许写入；
- provenance；
- session / task / skill 绑定；
- Skill 文件权限；
- 审计日志；
- 防止 Worker 修改其他 Skill；
- Learning Checkpoint 进入后不得继续解题、重新调查或扩大任务范围。

Runtime 负责“何时触发”和“权限边界”，模型通过 `skill-evolution` 负责“是否值得学、学什么”。

## 7.5 Learning 使用当前任务会话的结束钩子

Learning **不得启动独立 Session**。

也不要在任务执行过程中长期注入 Learning 规则。正确做法是在当前对话任务已经完成、Agent 会话即将结束时，由 Runtime 触发一次轻量的 `skill-evolution` Skill。

推荐：

```text
当前 Explore / Bootstrap 会话
  ↓
主任务已经完成或本 Intent 已经结束
  ↓
停止继续执行任务
  ↓
Runtime 触发 end-of-task learning hook
  ↓
按需加载 skill-evolution
  ↓
当前模型复盘本次已经完成并验证的工作
  ↓
模型自行判断是否存在可积累经验
  ↓
  ├─ 无 → 返回 no-learn，直接结束当前 Agent 会话
  └─ 有 → 调用 redtrace-skill learn 后结束当前 Agent 会话
```

该机制必须满足：

- 不创建第二个 Claude/Codex/Pi Session；
- 不重新启动 Worker；
- 不增加新的 Agent 并发占用；
- 不为了 Learning 重放完整对话；
- 不在主任务执行阶段常驻 `skill-evolution` 内容；
- 只有任务结束时才加载一次；
- Learning 阶段禁止继续扫描、攻击、验证或补做当前任务。

Runtime 可以在会话外维护一份极小的元数据，例如：

```json
{
  "project_id": "...",
  "intent_id": "...",
  "worker": "...",
  "loaded_skills": ["pwn"],
  "evidence_refs": ["..."],
  "artifact_refs": ["..."]
}
```

这份元数据只是给当前会话结束阶段提供可信边界，不用于创建新的模型 Session。

模型已经拥有本次任务的当前会话上下文，因此无需重新灌入完整任务历史。

这样实现后：

```text
主任务执行期间：
skill-evolution = 0 token

任务结束时：
临时加载 skill-evolution
→ 当前模型决定 learn / no-learn
→ 当前会话立即结束
```

既保留模型自主学习判断，又不会额外占用 Agent 工具会话。

---

# 8. Skill Routing 与 Recall 的新实现

## 8.1 Routing 不再作为 Prompt

删除当前类似：

```text
每个任务开始时优先检查 Worker 原生 Skill 索引……
每个任务选择一个主 Skill……
最多四个……
```

的常驻提示。

改为：

```text
Runtime 维护 Skill Catalog
+
Agent 原生 Skill discovery
```

Skill Catalog 只读取 frontmatter：

```text
name
description
```

不提前把 `SKILL.md` 正文塞入上下文。

## 8.2 推荐的 Routing 过程

```text
Current Intent
    ↓
读取 Skill Catalog 元数据
    ↓
候选过滤
    ↓
Agent/Runtime 选择真正相关 Skill
    ↓
只加载选中的 SKILL.md
```

不相关 Skill：

```text
0 正文 Token
```

## 8.3 Recall 自动执行

目标：

```text
load pwn
```

自动变成：

```text
load pwn
→ redtrace-skill recall pwn
```

模型不再需要记得执行 recall。

实现建议：

新增统一 Skill load hook：

```python
on_skill_loaded(canonical_id, task_context):
    audit_skill_load(...)
    recall = redtrace_skill_recall(canonical_id)
    attach_recall_to_loaded_skill_context(recall)
```

如果 Claude/Codex/Pi 原生 Skill 系统不能直接提供 load event：

1. 不要重新把规则塞回 Prompt；
2. 在 RedTrace Skill 发现/加载路径上增加包装层；
3. 或从 Agent audit/session event 中识别 Skill load；
4. 再由 Runtime 自动 recall。

---

# 9. Blackboard 从 Prompt 移到事件驱动 Runtime

当前长说明应全部删除。

保留现有 BlackboardInbox 思路：

```text
heartbeat
  ↓
revision 变化
  ↓
BlackboardInbox 获取增量
  ↓
写入 $REDTRACE_BLACKBOARD_NOTICE
```

但 Worker 不再在初始 Prompt 中阅读 Blackboard 手册。

只有真的发生更新时，发送很短的 steering：

```text
Blackboard updated to revision 37.
Relevant incremental data: $REDTRACE_BLACKBOARD_NOTICE
```

如果系统可以直接判断与当前 Intent 相关，则进一步改为：

```text
Blackboard update: f037 may affect the current Intent.
Incremental context: $REDTRACE_BLACKBOARD_NOTICE
```

未变化：

```text
0 token
```

需要高级溯源时，模型按需加载：

```text
redtrace-blackboard
```

Skill。

---

# 10. Workspace 从 Prompt 移到 Runtime

默认：

```text
Worker cwd = $REDTRACE_WORKSPACE
```

所有 Worker 都从同一 Workspace 启动。

运行时创建：

```text
$REDTRACE_WORKSPACE/.tmp
$REDTRACE_WORKSPACE/.redtrace
```

并设置临时目录环境变量。

共享文件冲突不通过长 Prompt 预防，而通过：

```text
Resource lock
+ 423 Conflict
```

处理。

当第一次发生共享文件写入/锁冲突时，才动态提示：

```text
Shared-file conflict detected. Load redtrace-workspace for collaboration rules.
```

或者由 Runtime 直接返回 lock owner / resource id。

---

# 11. Resource / WebShell / C2 从 Prompt 移出后的可靠性保证

不能只依赖 Skill，否则 Agent 可能忘记加载。

必须保留并强化 Runtime Guard。

## 11.1 Access Resource Guard

当 Explore 输出中声称：

```text
获得 WebShell
获得 reverse shell
获得 C2 Session
获得 SSH / Evil-WinRM / PsExec / WMI shell
```

但没有对应 Resource ID：

```text
不要提交正式 Fact
```

而是执行一次有界修复：

```text
Access channel claimed but no registered Resource exists.
Register the channel using RedTrace Resource tooling, then return the same fact with Resource ID.
```

这个修复 Prompt 只在异常时出现，不常驻。

## 11.2 Credential Guard

Credential 不能通过 Prompt 规则保证。

Control Plane 应：

- Secret 字段单独存储；
- Fact 写入前做 secret redaction；
- 最终 description 不允许出现 credential secret；
- 对应 Fact 只引用 `credential_ref` Resource ID。

## 11.3 C2 生命周期

Runtime 强制：

```text
reverse session
→ listener_id 必须存在

bind session
→ connector/listener Resource 必须存在

external C2 session
→ connection_type=external_c2
```

Skill 只告诉模型“怎么操作”。

---

# 12. Context Harness 完全退出主 Prompt

当前类似：

```text
继续优先使用 RTK……
输出过大时使用 redtrace-context run……
raw data 位于……
```

全部删除。

目标架构：

```text
Agent command
   ↓
RTK
   ↓
透明 Context Harness
   ↓
小输出 → 原样返回
大输出 → Artifact
```

大输出时，工具返回：

```text
Output stored as context artifact ctx_123.
Summary: ...
Query with artifact selector if additional evidence is needed.
```

这是一条**结果消息**，不是长期系统提示。

## 12.1 推荐实现

优先方案：

```text
把 Context Harness 做成 RTK 的透明后处理层
```

而不是要求 Agent 主动：

```bash
redtrace-context run -- rtk ...
```

如果短期无法透明化，可暂时保留 `redtrace-context` Skill，但不得常驻主 Prompt；当 Runtime 检测到大输出风险时按需提示加载。

---

# 13. Prompt 模板回退原则

## 13.1 不直接复制 Cairn 英文

采用：

```text
Cairn 语义
+ 中文
+ RedTrace 必需 Contract
```

## 13.2 不把 Reason Contract 回退成旧 Cairn

必须继续保留：

```text
create
drop
reprioritize
supersede
complete
```

否则会丢失 RedTrace Frontier 管理能力。

也就是：

```text
语义复杂度回退到 Cairn
数据 Contract 保留 RedTrace
```

---

# 14. 最终 `reason.md`

替换：

```text
redtrace/src/redtrace/dispatcher/prompts/default/reason.md
```

为：

```markdown
# 任务

你将收到 task graph 的 YAML snapshot。Fact 表示已确认的关键客观事实，Intent 表示待探索方向。

理解当前任务、已有事实和探索进展，并判断：

1. 当前 Fact 是否已经满足 Goal；
2. 如果未满足，当前 search frontier 是否需要调整。

你可以创建新的 Intent、删除已失效的 ready Intent、调整 ready Intent 的优先级、用更有效的 ready Intent 替代旧 Intent，或在 Goal 已满足时完成任务。

Intent 应是明确、独立、可验证且可并行执行的高价值探索方向，避免与已有 Intent 重复。不要执行属于 Explore 的深入调查。

# 输出

只返回一个 raw JSON object，不得输出其他内容。

正常结构：

{
  "accepted": true,
  "data": {
    "create": [],
    "drop": [],
    "reprioritize": [],
    "supersede": [],
    "complete": null
  }
}

`create` 项：

{
  "from": ["f001"],
  "description": "...",
  "priority": 80
}

`drop` 项：

{
  "intent_id": "i001",
  "reason": "..."
}

`reprioritize` 项：

{
  "intent_id": "i001",
  "priority": 90,
  "reason": "..."
}

`supersede` 项：

{
  "intent_id": "i001",
  "by": "i002",
  "reason": "..."
}

若 Goal 已满足：

{
  "from": ["f001"],
  "description": "..."
}

写入 `complete`，且不要同时创建新的 Intent。

若当前无需调整，返回空 GraphPatch。

`from` 只能引用 Valid facts。只能修改允许修改的 ready Intent；working Intent 保持只读。

# 上下文

## Graph

{graph_yaml}

## Valid facts

{fact_ids}

## Open Intents

{open_intents}

## Execution

{execution}
```

---

# 15. 最终 `explore.md`

替换：

```text
redtrace/src/redtrace/dispatcher/prompts/default/explore.md
```

为：

```markdown
# 任务

你将收到 task graph 和一个 Current Intent。

只沿 Current Intent 进行充分探索，并尽可能推动任务接近 Goal。

该方向可能成功，也可能失败。若已经无法沿当前 Intent 获得新的有效进展，可以结束。

如果同一 session 后续收到 conclude phase 指令，新指令立即覆盖当前探索要求；此时停止继续探索，并按 conclude 要求返回结果。

# 输出

只返回一个 raw JSON object，不得输出其他内容。

正常返回：

{
  "accepted": true,
  "data": {
    "description": "..."
  }
}

`description` 只记录本次新确认的关键客观事实，不重复 Graph 中已经存在的信息，不包含计划、猜测或无助于推进 Goal 的过程性内容。

大量原始数据写入 Workspace 文件或 Artifact，并在 `description` 中引用。

# 上下文

## Graph

{graph_yaml}

## Current Intent

{intent_id}

## Current Intent Description

{intent_description}
```

---

# 16. 最终 `explore_conclude.md`

替换为：

```markdown
# 任务

这是 conclude phase。

立即停止当前探索。不要继续运行命令、调用工具、等待结果或获取新的信息。

只根据本 conclude 指令之前已经确认的信息，总结当前 Intent 最新获得、并且有助于实现 Goal 的关键客观事实。

# 输出

只返回一个 raw JSON object，不得输出其他内容。

正常返回：

{
  "accepted": true,
  "data": {
    "description": "..."
  }
}

`description` 不得包含计划、猜测、未确认的信息或 Graph 中已经存在的重复事实。

# 上下文

## Graph

{graph_yaml}

## Current Intent

{intent_id}

## Current Intent Description

{intent_description}
```

---

# 17. 最终 `bootstrap.md`

替换为：

```markdown
# 任务

你将收到 Origin、Goal 和 Hints。

理解起点和已有信息，并持续推进任务，直到 Goal 实现。

如果 Goal 尚未实现，继续工作，不要自行把部分进展当作完成。

如果同一 session 后续收到 conclude phase 指令，新指令立即覆盖继续工作的要求；此时停止继续探索，并按 conclude 要求返回结果。

# 输出

仅在已经确认 Goal 满足时返回：

{
  "accepted": true,
  "data": {
    "fact": {
      "description": "..."
    },
    "complete": {
      "description": "..."
    }
  }
}

`fact.description` 记录本次已经确认的关键客观结果。

`complete.description` 说明为什么当前已确认结果足以证明 Goal 已实现。

大量原始数据写入 Workspace 文件或 Artifact，并在结果中引用。

# 上下文

## Origin

{origin}

## Goal

{goal}

## Hints

{hints}
```

---

# 18. 最终 `bootstrap_conclude.md`

替换为：

```markdown
# 任务

这是 conclude phase。

立即停止继续执行。不要运行新的命令、调用工具、等待未完成结果或获取新的信息。

只总结本 conclude 指令之前已经确认、并且对实现 Goal 有帮助的关键客观事实。

# 输出

只返回一个 raw JSON object，不得输出其他内容。

正常返回：

{
  "accepted": true,
  "data": {
    "fact": {
      "description": "..."
    }
  }
}

本阶段不得输出 `complete`。

`fact.description` 只能包含已经确认的客观事实，不得包含计划、猜测或未确认信息。

# 上下文

## Origin

{origin}

## Goal

{goal}

## Hints

{hints}
```

---

# 19. `prompting.py` 改造

目标文件：

```text
redtrace/src/redtrace/dispatcher/prompting.py
```

## 19.1 删除长期 Prompt 注入

删除或停止使用：

```text
LANGUAGE_GUIDANCE
FINAL_OUTPUT_CONTRACT
add_blackboard_guidance()
```

`render_prompt()` 回退到 Cairn 风格：

```python
def render_prompt(template: str, replacements: dict[str, str]) -> str:
    text = template
    for key, value in replacements.items():
        text = text.replace("{" + key + "}", value)
    return text.rstrip()
```

模板已经是中文，因此无需再追加：

```text
## 输出语言
```

模板已经包含输出 schema，因此无需再追加：

```text
## Final output contract
```

## 19.2 保留格式化函数

保留：

```text
load_prompt
format_fact_ids
format_open_intents
format_hints
format_json_block
```

---

# 20. `bootstrap.py` 改造

目标：

```text
redtrace/src/redtrace/dispatcher/tasks/bootstrap.py
```

删除：

```python
prompt = add_blackboard_guidance(...)
```

Bootstrap 最终输入仅为：

```text
bootstrap.md
+ origin
+ goal
+ hints
```

保留：

- session；
- heartbeat；
- cancellation；
- conclude fallback；
- contract validation；
- result commit；
- completion commit。

不要因为 Prompt 回退而删除 Runtime 行为。

---

# 21. `explore.py` 改造

目标：

```text
redtrace/src/redtrace/dispatcher/tasks/explore.py
```

删除固定：

```python
add_blackboard_guidance(...)
```

最终 initial Prompt 仅：

```text
explore.md
+ graph reference
+ intent id
+ intent description
```

保留：

- BlackboardInbox；
- steering；
- session；
- heartbeat；
- conclude fallback；
- Resource guard；
- `_attach_access_resource_ids()` 或等价机制；
- contract validation；
- learning trigger；
- session checkpoint。

## 21.1 Resource 修复提示保留为异常路径

类似：

```text
声明建立 shell/WebShell/C2，但没有 Resource ID
```

时允许 Runtime 发送一次短 correction。

这不是常驻 Prompt，因此保留。

---

# 22. `reason.py` 改造

目标：

```text
redtrace/src/redtrace/dispatcher/tasks/reason.py
```

删除：

```python
add_blackboard_guidance(...)
```

保留：

- Graph reference；
- Valid Fact IDs；
- Open Intent 状态；
- Execution capacity；
- GraphPatch validator；
- create limit；
- planning revision；
- format-only repair；
- timeout recovery；
- BlackboardInbox。

Reason 不再收到 Blackboard 使用手册。

如果 Graph 在文件中，Prompt 只收到 Graph reference，继续保持“不 inline 大 Graph”的现有设计。

---

# 23. `skill_runtime.py` 改造

目标：

```text
redtrace/src/redtrace/skill_runtime.py
```

## 23.1 删除主任务常驻 Skill Policy

不再向 Explore/Bootstrap 返回：

```text
SKILL_RUNTIME_INSTRUCTIONS
```

主任务 Prompt 中 Skill Runtime Policy 应为：

```text
0 token
```

## 23.2 重构职责

建议拆成：

```python
class SkillRuntime:
    discover(...)
    on_skill_loaded(...)
    recall(...)
    record_usage(...)
    build_learning_bundle(...)
    run_evolution_checkpoint(...)
```

其中：

```text
discover
on_skill_loaded
recall
record_usage
```

都是 Runtime。

`run_evolution_checkpoint()` 不再启动当前会话的结束阶段，而是在当前任务会话结束前触发 `skill-evolution`：

```text
current agent session
→ end-of-task hook
→ load skill-evolution
→ learn / no-learn
→ close current session
```

---

# 24. 新增 Learning Runtime

建议新增：

```text
redtrace/src/redtrace/skills/evolution.py
```

或：

```text
redtrace/src/redtrace/skill_evolution.py
```

职责：

1. 记录本任务实际加载的 Skill；
2. 记录已确认结果以及 evidence/artifact refs；
3. 在当前对话任务已经结束、但当前 Agent 会话尚未释放时触发一次 end-of-task hook；
4. 向**当前 Agent 会话**按需加载 `skill-evolution`；
5. 明确将当前阶段切换为“只复盘，不继续任务”；
6. 由当前模型自行判断 `learn` 或 `no-learn`；
7. 如果决定学习，只允许调用 `redtrace-skill learn` 更新本次实际使用过的专业 Skill；
8. 写入 Learning 审计；
9. Learning 完成后立即释放当前 Agent 会话。

明确禁止：

```text
创建当前会话的 end-of-task Learning Hook
重新启动 Claude/Codex/Pi 会话
额外占用 Worker 槽位
重新执行目标
继续攻击
重新扫描
补做未完成 Intent
```

Learning Runtime 本身不负责判断经验是否值得积累；该判断由当前模型在 `skill-evolution` Skill 的约束下完成。

---

# 25. 新增 Skill Load 审计

为了让 Runtime 知道“这次到底加载过哪些 Skill”，必须有可信记录。

建议统一记录：

```json
{
  "project_id": "proj_001",
  "intent_id": "i023",
  "worker": "Pi",
  "skill": "pwn",
  "event": "load",
  "timestamp": "..."
}
```

Recall：

```json
{
  "skill": "pwn",
  "event": "recall",
  "memory_ids": ["..."]
}
```

Learning：

```json
{
  "skill": "pwn",
  "event": "learn",
  "experience_id": "...",
  "evidence_refs": ["..."]
}
```

Learning 只能写入：

```text
本任务真正 load 过的专业 Skill
```

除 `skill-evolution` 自身外，不允许越权修改其他未使用 Skill。

---

# 26. Skill Memory 建议升级

建议经验对象逐步结构化：

```json
{
  "id": "exp_xxx",
  "skill": "pwn",
  "summary": "...",
  "content": "...",
  "confidence": 0.92,
  "verified_count": 3,
  "failed_count": 0,
  "last_verified_at": "...",
  "environment": {
    "os": "...",
    "tool_version": "..."
  },
  "evidence_refs": ["..."],
  "status": "active"
}
```

支持：

```text
append
reinforce
supersede
deprecate
```

不要让所谓“自进化”退化成：

```text
无限 append learned.md
```

---

# 27. Context Harness Runtime 化实施建议

目标不是简单删除 Prompt，而是确保删除后能力仍存在。

## 第一阶段

保留现有 Context Harness 实现，但：

- 从主 Prompt 中删除手册；
- 仅在输出超阈值时动态返回 artifact 提示。

## 第二阶段

实现透明包装：

```text
RTK
  ↓
Context Capture
```

所有超阈值输出自动：

```text
保存 raw
生成摘要
返回 artifact id
```

## 验收条件

普通任务即使完全不知道：

```text
redtrace-context run
```

也不会因为大输出直接污染整个上下文。

---

# 28. WebShell/C2 Runtime Guard 实施建议

Skill 迁移后必须验证以下行为。

## 情况 A：普通 SQLi

不得加载：

```text
redtrace-webshell
redtrace-c2
```

## 情况 B：SQLi 获得命令执行但不建立持久通道

可以不加载 C2。

## 情况 C：获得 WebShell

按需加载：

```text
redtrace-webshell
```

注册失败：

```text
Runtime 阻止最终 shell Fact
→ 一次短 correction
```

## 情况 D：reverse shell

按需加载：

```text
redtrace-c2
```

如果没有 listener：

```text
Runtime 不接受 reverse session
```

## 情况 E：外部 C2

按需加载：

```text
redtrace-c2
```

并通过 Resource 同步 Session。

---

# 29. 不能迁到 Skill 的内容

以下即使希望“全部转 Skill”，也不应转：

```text
GraphPatch schema 合法性
Intent state 合法性
planning_revision
Resource ID 真实性
Credential Secret 安全
Listener/Session 关系
锁冲突
Heartbeat
Cancellation
Context 输出阈值
Skill 写入权限
Learning 触发
Session checkpoint
```

原因：

```text
Skill = 模型可能遵循
Runtime = 系统必须保证
```

把系统不变量放 Skill 会重新引入：

```text
Agent 忘记
Agent 没加载
Agent 理解错误
```

导致可靠性回退。

---

# 30. 迁移顺序

建议严格按以下顺序实施。

## Phase 1：先做 Runtime Guard，暂不删 Prompt

完成：

- Resource guard；
- Credential guard；
- Skill load audit；
- auto recall；
- Learning Runtime；
- Blackboard event；
- Workspace cwd；
- Context Harness 自动处理。

此时功能行为应与当前版本一致。

## Phase 2：创建新 Skill

新增：

```text
redtrace-blackboard
redtrace-workspace
redtrace-resource
redtrace-webshell
redtrace-c2
web-research
exploit-research
tool-bootstrap
skill-evolution
```

写测试验证可以被各 Worker 原生 Skill 发现。

## Phase 3：移除 `add_blackboard_guidance()`

从：

```text
bootstrap.py
reason.py
explore.py
```

删除常驻注入。

运行全部现有测试。

## Phase 4：替换 5 个模板

替换：

```text
bootstrap.md
bootstrap_conclude.md
reason.md
explore.md
explore_conclude.md
```

## Phase 5：删除旧 Skill Runtime Prompt

删除：

```text
SKILL_RUNTIME_INSTRUCTIONS
```

或改为空实现，仅保留兼容接口。

## Phase 6：A/B Benchmark

使用相同：

```text
模型
题集
Worker 数量
运行时间
```

对比：

```text
旧 RedTrace Prompt
新 Cairn 中文精简 Prompt
```

---

# 31. 必须新增的测试

## 31.1 Prompt 长度测试

新增：

```text
test_prompt_is_cairn_style_minimal
```

断言 Explore initial Prompt 不得出现：

```text
共享 Blackboard 决策刷新
共享 Workspace contract
Active WebShell 与 C2 工作流
RedTrace Skill Runtime Policy
Context Harness
Web 调研顺序
已知漏洞优先利用
共享工具 Bootstrap
```

## 31.2 Prompt 结构测试

断言：

```text
Reason:
graph_yaml
fact_ids
open_intents
execution
max_intents

Explore:
graph_yaml
intent_id
intent_description

Bootstrap:
origin
goal
hints
```

全部仍然存在。

## 31.3 Blackboard 测试

即使初始 Prompt 没有 Blackboard 手册：

```text
revision 变化
→ Worker 仍收到 notice/steering
```

## 31.4 Resource 测试

Explore 声称：

```text
取得 reverse shell
```

但没有真实 Resource：

```text
不能直接写正式 Fact
```

## 31.5 WebShell 测试

不加载 WebShell Skill 时：

```text
普通 Explore 正常运行
```

实际获得 WebShell 时：

```text
Skill 可按需发现
Resource Guard 可阻止漏登记
```

## 31.6 C2 测试

reverse session：

```text
没有 listener → rejected/correction
有 listener → accepted
```

## 31.7 Skill Recall 测试

```text
load pwn
→ 自动产生 recall audit
```

模型 Prompt 不需要出现 recall 指令。

## 31.8 Learning 测试

任务结束：

```text
Runtime 在当前 Agent 会话释放前自动触发 skill-evolution
```

必须断言：

```text
不会创建新的 Agent Session
不会重新启动 Worker
不会额外占用 Worker 槽位
```

没有新经验：

```text
模型返回 no-learn
不写 memory
当前会话结束
```

有可复用新经验：

```text
模型决定 learn
只更新实际使用过的 Skill
写入审计
当前会话结束
```

## 31.9 Context Harness 测试

模拟超大输出：

```text
不依赖 Agent 主动调用 redtrace-context
→ 自动 Artifact
→ 主上下文只得到摘要和引用
```

## 31.10 回归测试

必须覆盖：

- Claude
- Codex
- Pi
- local
- container
- Bootstrap
- Reason
- Explore
- conclude fallback
- timeout recovery
- format repair
- pause/resume
- Blackboard revision
- Resource
- Skills
- Learning

---

# 32. Benchmark 验收指标

至少记录：

```text
平均 initial prompt tokens
总 input tokens
总 output tokens
每题平均 Explore 次数
Reason 次数
Fact yield
重复 Intent 数
Contract error 数
Resource 漏登记数
Skill load 数
Skill recall 数
Learning 写入数
最终得分
解题数
平均解题耗时
```

目标：

## Prompt

```text
Explore initial prompt
接近 Cairn 中文版复杂度
```

目标可定义为：

```text
固定协议正文 < 当前版本的 25%
```

更理想：

```text
固定协议正文接近 0
```

## 能力

以下不得下降：

```text
Resource 登记成功率
WebShell/C2 管理同步率
Skill 使用正确率
Blackboard 协作能力
最终 Benchmark 得分
```

---

# 33. 预期 Token 效果

原模式：

```text
每个 Explore
→ 重复注入 Blackboard/Workspace/Web/C2/Skill/Context 等固定规则
```

新模式：

```text
普通 Explore
→ Cairn 中文模板
→ Intent
→ Graph reference
```

只有发生具体需求时：

```text
Web 调研 → 加载 web-research
C2 → 加载 redtrace-c2
WebShell → 加载 redtrace-webshell
高级 Blackboard → 加载 redtrace-blackboard
工具缺失 → 加载 tool-bootstrap
任务结束 → 在当前会话结束钩子中加载 skill-evolution
```

因此从：

```text
“每轮全部加载”
```

变成：

```text
“事件驱动、按需加载”
```

真正减少的是重复输入 Token，而不仅是 Markdown 文件大小。

---

# 34. 回滚方案

保留一个配置开关：

```yaml
runtime:
  prompt_mode: minimal
```

兼容：

```yaml
runtime:
  prompt_mode: legacy
```

建议：

```text
minimal = 新 Cairn 中文精简模式
legacy  = 当前 RedTrace add_blackboard_guidance 模式
```

在完成 Benchmark 验证前不要立即删除 legacy 代码。

验证通过后：

1. `minimal` 设为默认；
2. 再经过一轮正式 Benchmark；
3. 最后删除 legacy。

---

# 35. 最终目标架构

```text
                    ┌──────────────────────┐
                    │ Cairn-style Prompt   │
                    │ 当前任务 / Intent    │
                    │ 最小输出 Contract    │
                    └──────────┬───────────┘
                               │
                        需要专业能力
                               ↓
                    ┌──────────────────────┐
                    │ Lazy Skills          │
                    │ Web/Pwn/C2/...       │
                    └──────────┬───────────┘
                               │
                            执行任务
                               ↓
┌──────────────────────────────────────────────────────────┐
│ Runtime / Harness / Control Plane                       │
│                                                        │
│ Blackboard events                                      │
│ Workspace                                              │
│ Resource                                               │
│ Credential Secret                                      │
│ Listener/Session lifecycle                             │
│ Context Harness                                        │
│ Contract Validator                                     │
│ Skill load audit                                       │
│ Auto Recall                                            │
│ Learning trigger                                       │
└─────────────────────────────┬────────────────────────────┘
                              │
                  当前任务结束、会话尚未释放
                              ↓
                    ┌──────────────────────┐
                    │ End-of-task Hook     │
                    │ skill-evolution      │
                    │ 当前模型自主判断      │
                    └──────────┬───────────┘
                               ↓
                         Skill Memory
                               ↓
                       释放当前 Agent 会话
```

---

# 36. 最终结论

本次改造不应该理解为：

```text
把所有 Prompt 内容机械地复制进 Skill
```

正确方案是：

```text
需要模型理解的操作知识
→ 按需 Skill

可以由程序确定的系统规则
→ Runtime / Harness / Control Plane

阶段任务本身
→ Cairn 中文精简 Prompt
```

最终主任务 Prompt 只承担：

```text
我现在是什么阶段？
我要做什么？
当前 Intent 是什么？
Graph/Goal 在哪里？
我要返回什么？
```

而：

```text
Blackboard
Workspace
Resource
WebShell
C2
Skill Routing
Skill Recall
Learning
Context Harness
```

全部从“每轮反复解释给模型”改成“系统自动提供能力，需要时才暴露操作知识”。

这样可以在保留 RedTrace 现有增强能力的同时，把 Worker 的主上下文重新压回 Cairn 的简洁风格，并显著降低重复输入 Token 和指令稀释。
