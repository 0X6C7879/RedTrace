---
name: 西湖论剑API
description: 用于在西湖论剑平台上解答 CTF 题目。通过平台 AI Agent API 获取竞赛规则、题目列表、题目详情、附件和靶机连接信息，按需启动并轮询题目环境，辅助 Agent 开展 CTF 解题，在得到 flag 后提交答案，并查询排名、公告或回收环境。遇到西湖论剑、CTF 竞赛题、exerciseId、X-Agent-AccessKey 或 /slab-match/api/v1/agent 接口时优先使用本 Skill。
---

# 西湖论剑API

本 Skill 用于让 Agent **在西湖论剑平台上完成 CTF 题目解答流程**。

它不是单纯的 API 查询工具，而是西湖论剑 CTF 解题时的平台控制面：负责读取竞赛规则、发现题目、获取题面和附件、获取/初始化靶机、确认靶机可用状态、向解题 Agent 提供目标信息、提交 flag，并在需要时查询公告、排名或回收环境。

## 适用场景

遇到以下任一情况时，应优先加载本 Skill：

- 当前任务是在西湖论剑平台解答 CTF 题目。
- 任务提供了西湖论剑 Agent API 的 Host 和 AccessKey。
- 需要获取 CTF 题目列表、题目详情、附件或靶机连接信息。
- 题目环境需要初始化、等待启动、重建或回收。
- 已获得候选 flag，需要通过平台 API 提交验证。
- 需要查看西湖论剑竞赛规则、公告、得分或排名。
- 上下文中出现 `exerciseId`、`X-Agent-AccessKey` 或 `/slab-match/api/v1/agent`。

## 竞赛规则要点

完整竞赛规则见 `references/competition_rules.md`。以下为 Agent 必须遵守的关键约束：

### flag 格式

- flag 格式为 `DASCTF{}` 或 `flag{}`
- **提交时仅需提交 `{}` 内内容**，不要提交 `DASCTF{...}` 或 `flag{...}` 完整字符串
- 若有特殊格式要求将在题目内注明

### 提交限制

- **每题 flag 最大提交次数为 50 次**，超过 50 次将无法提交
- 禁止对赛题 flag 进行爆破，违规者取消比赛成绩
- CLI 的 `submit` 命令内置计数保护（本地文件记录），但 Agent 也应自行控制提交频率

### 计分规则

- 递减模式：题目分数随解题人数增加逐步减少（每次 -1% 初始分，最低 80%）
- 排名按分数降序，同分按时间升序
- 影响策略：优先攻克高价值、低解题人数的题目

### Agent 接入限制

- 每支队伍仅允许 **1 个 Agent** 接入平台
- 必须使用平台提供的大模型网关，所有通信经由授权 API 端点白名单
- 比赛结束后 flag 无法提交；赛前需提交解题报告

## 必需配置

从竞赛任务或运行环境中获取：

- `AI_AGENT_HOST`：西湖论剑平台服务端 Origin，例如 `https://example.com`。不要附加 `/slab-match/api/v1/agent`。
- `AI_AGENT_ACCESS_KEY`：Agent AccessKey，请求时作为 `X-Agent-AccessKey` Header。

优先使用环境变量，避免凭据进入命令历史、提示词或日志：

```bash
export AI_AGENT_HOST='https://example.com'
export AI_AGENT_ACCESS_KEY='ak_xxx'
```

不得猜测 Host、AccessKey、exerciseId、附件 URL、靶机地址、账号密码、代理映射、flag 或 API 响应。缺少必要值时，应明确报告缺失项。

## 推荐调用方式

优先使用 Skill 内置的零第三方依赖 CLI：

```bash
python3 scripts/slab_agent_api.py match-info
python3 scripts/slab_agent_api.py exercises
python3 scripts/slab_agent_api.py detail 1001
python3 scripts/slab_agent_api.py ensure-env 1001
python3 scripts/slab_agent_api.py submit 1001 'flag{...}'
python3 scripts/slab_agent_api.py overview
```

查看全部命令：

```bash
python3 scripts/slab_agent_api.py --help
```

如果当前工作目录不是 Skill 目录，应根据本 `SKILL.md` 所在路径解析 `scripts/slab_agent_api.py`，不要假设固定 cwd。

## 西湖论剑 CTF 解题工作流

### 1. 读取竞赛规则

新任务或新竞赛会话开始时，先执行：

```bash
python3 scripts/slab_agent_api.py match-info
```

读取并遵守平台返回的 `note` 和 `rule`。如果规则与默认解题习惯冲突，以平台规则为准。

### 2. 获取可解题目

执行：

```bash
python3 scripts/slab_agent_api.py exercises
```

从题目列表中识别开放且尚未完成的题目。后续详情查询、环境操作和 flag 提交均使用题目 `id` 作为 `exerciseId`。

### 3. 获取题面、附件和靶机信息

在对题目采取实质性解题操作前，必须执行：

```bash
python3 scripts/slab_agent_api.py detail <exerciseId>
```

重点提取：

- `description`：题目描述。
- `attachment.files[].url`：题目附件下载地址。
- `endpoints`：靶机连接信息。
- `endpoints[].exposeIps`：靶机 IP。
- `endpoints[].ports`：开放端口。
- `endpoints[].users`：平台提供的账号密码。
- `endpoints[].isProxy`：是否优先通过代理连接。
- `endpoints[].proxyIps`：代理 IP。
- `endpoints[].portMappings`：靶机端口与代理端口映射。
- `expireTime`：靶机过期时间。
- `isNeedInit`：是否需要初始化环境。
- `isNeedCheck`：环境是否仍在准备中。

将这些信息作为实际 CTF 解题的输入。不得自行改写或猜测连接信息。

### 4. 确保题目环境可用

如果详情中 `isNeedInit=true`，优先执行：

```bash
python3 scripts/slab_agent_api.py ensure-env <exerciseId>
```

`ensure-env` 会：

1. 查询题目详情。
2. 在需要时请求创建题目环境。
3. 持续轮询题目详情。
4. 仅在 `isNeedCheck=false` 且 `endpoints` 非空时视为环境可用。

默认轮询间隔 3 秒、超时 300 秒，可调整：

```bash
python3 scripts/slab_agent_api.py ensure-env 1001 --interval 5 --timeout 600
```

环境仍在准备时，不得猜测目标地址，也不要把“启动请求成功”误判为“靶机已经可用”。

### 5. 开展 CTF 解题

环境可用后，结合：

- 题目描述；
- 附件；
- 实际靶机 IP/端口；
- 平台提供的凭据；
- 代理或端口映射；
- 当前 Agent 已具备的 CTF / Web / Pwn / Crypto / Reverse / Misc / Blockchain 等解题能力和相关 Skills；

开展题目分析和验证，目标是得到可信的候选 flag。

本 Skill 负责**西湖论剑平台交互与题目生命周期**；具体漏洞分析、逆向、密码分析、取证等解题过程，应调用与题型匹配的专项 Skill/工具完成。

### 6. 提交 flag

得到候选 flag 后：

```bash
python3 scripts/slab_agent_api.py submit <exerciseId> '<flag_content>'
```

**flag 格式要求**：

- flag 格式为 `DASCTF{xxx}` 或 `flag{xxx}`
- **提交时仅需提交 `{}` 内的内容**，即 `xxx` 部分，不要提交完整格式
- 若候选 flag 包含 `DASCTF{` 或 `flag{` 前缀，需先提取花括号内内容再提交

**提交限制**：

- 每题最多提交 50 次，CLI 内置计数保护
- 禁止 flag 爆破，违规取消成绩
- 应优先通过漏洞分析缩小候选范围，减少无效提交

**成功判定**：

只有同时满足以下条件才能把题目标记为已解：

- API 公共响应 `code == "00000"`；
- `data.isCorrect == true`。

仅 API 请求成功但 `isCorrect` 不为 `true`，不能视为解题成功。

`flag` 最长 256 字符。

### 7. 继续下一题

提交正确后，重新执行：

```bash
python3 scripts/slab_agent_api.py exercises
```

选择下一个开放且未解决的题目，并重复“详情 → 环境 → 解题 → 提交”的流程。

### 8. 公告、排名和环境回收

查询得分/排名：

```bash
python3 scripts/slab_agent_api.py overview
```

查询竞赛公告：

```bash
python3 scripts/slab_agent_api.py notices
python3 scripts/slab_agent_api.py notice <noticeId>
```

如果公告可能改变题目、规则或环境，应在继续解题前读取公告详情。

仅在题目环境不再需要或明确需要重置/重建时回收：

```bash
python3 scripts/slab_agent_api.py recover <exerciseId>
```

不要在仍需利用当前靶机状态时主动回收环境。

## API 成功判定

所有接口使用统一响应结构：

```json
{"code":"00000","message":"","data":{}}
```

处理规则：

- 只有 `code == "00000"` 才表示 API 调用成功。
- 其他 `code` 均视为失败，应保留并报告 `message`，不得伪造 `data`。
- flag 提交还必须额外检查 `data.isCorrect == true`。

## 代理连接解释

如果 `endpoints[].isProxy=true`，应依据 API 返回的 `proxyIps` 与 `portMappings` 确定连接方式。

不要在没有证据的情况下：

- 把代理端口当成靶机原始端口；
- 把 `exposeIps` 和 `proxyIps` 随意互换；
- 自行构造不存在的目标地址。

## 常用命令速查

```bash
# 竞赛规则
python3 scripts/slab_agent_api.py match-info

# 得分与排名
python3 scripts/slab_agent_api.py overview

# CTF 题目列表
python3 scripts/slab_agent_api.py exercises

# 题目详情、附件、靶机信息
python3 scripts/slab_agent_api.py detail 1001

# 按需初始化并等待靶机可用
python3 scripts/slab_agent_api.py ensure-env 1001

# 显式启动/回收环境
python3 scripts/slab_agent_api.py build 1001
python3 scripts/slab_agent_api.py recover 1001

# 提交 flag（自动剥离 DASCTF{}/flag{} 包装，内置 50 次计数保护）
python3 scripts/slab_agent_api.py submit 1001 'example_content'

# 查询某题已提交次数
python3 scripts/slab_agent_api.py submit-count 1001

# 公告
python3 scripts/slab_agent_api.py notices
python3 scripts/slab_agent_api.py notice 501
```

## curl 回退方式

Python 不可用时可直接使用 `curl`。

API Base URL：

```text
${AI_AGENT_HOST}/slab-match/api/v1/agent
```

所有请求必须包含：

```text
X-Agent-AccessKey: ${AI_AGENT_ACCESS_KEY}
```

POST 请求使用：

```text
Content-Type: application/json
```

需要核对原始字段、接口 Schema 或 curl 示例时，读取 `references/api_doc.md`。

需要查阅竞赛规则、计分方式、flag 格式、提交限制等竞赛细节时，读取 `references/competition_rules.md`。
