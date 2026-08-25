---
name: skill-evolution
description: Review verified outcomes and evolve Skills with reusable learnings from the current session.
---

# Skill Evolution

任务中产生经验证、可复用的新经验时加载本 Skill。

本 Skill 对 Claude Code、Codex 和 Pi 使用同一接口：`redtrace-skill` 是注入 `PATH` 的 shell CLI，必须通过当前 Worker 的 shell/terminal tool 执行。它不是 MCP server、MCP tool 或 MCP Resource；不要通过任何 MCP 接口调用，也不要为它构造 URI。

## 职责边界

- **模型**：判断是否产生新经验、经验归属于哪个 Skill、何时将 Memory 提炼为正式规则
- **skill-evolution（本 Skill）**：提供两级门槛和写入规范约束
- **Runtime**：只负责机械安全（脱敏、去重、格式校验、Reason 隔离），不替模型做 Learning 决策

## 写入目标（重要）

经验应写入**产生该经验的专业 Skill**（本次实际加载并使用过的专业 Skill）。

- 默认只 `learn` 专业 Skill，例如 `learn api-security`
- **不要默认 `learn skill-evolution`**：除非当前任务本身就是优化 Skill Evolution 机制，否则不要将普通专业经验写入 `skill-evolution`
- Skill 归属由模型判断；Runtime 只保证写入安全、规范、可追踪，不校验 loaded 状态

## 新经验判定

同时满足以下条件：

- **可复用**：不绑定特定项目/题目/目标，适用于同类场景
- **已验证**：基于本次实际执行并确认的结果，非猜测或理论推导
- **非项目事实**：不是当前目标的特有信息（IP、端口、flag、凭据等）
- **适用 Skill**：适用于本次实际使用过的专业 Skill

## 行动

### 1. Recall

加载后先运行 `redtrace-skill recall <canonical-id>` 消费已有经验，避免重复记录。

### 2. Level 1：Memory Learning（低门槛，快速、宽松、自主）

一次经过验证的可复用经验即可写入 Memory：

1. 在当前 Workspace 写一份脱敏说明文件
2. 运行 `redtrace-skill learn <canonical-id> --summary <摘要> --evidence <验证依据> --content-file <文件>`

参数要求：
- `--summary`：一行概括，不超过 240 字符
- `--evidence`：验证依据，不超过 500 字符
- `--content-file`：脱敏后的详细说明，不超过 16KB

主要依靠模型判断。Memory 是缓冲层：即使偶有一条 Memory 判断偏差，也不会马上污染正式 Skill。

### 3. Level 2：Skill Evolution（高门槛，慢速、谨慎、稳定）

当 Memory 中已积累 **≥3 条一致或互补**的经验时才可升级 Skill 本体：

1. 从 Memory 中抽象出稳定通用规则（不是项目事实的堆砌）
2. 直接编辑该 Skill 的 SKILL.md，将规则写入
3. 检查确认没有破坏原 Skill 的结构与意图

```text
执行结果 → Memory（快速沉淀）→ 反复验证 → SKILL.md（稳定进化）
```

### 4. 无新经验

直接确认，不写文件，不调用 learn。

## 脱敏规则

写入内容必须移除：

- IP 地址、URL、域名
- 密码、Token、API Key、凭据
- Flag、CTF 标志
- 工作区绝对路径
- 私钥

## 去重

`redtrace-skill learn` 内置去重机制：

- 完全相同的 summary + content 会被拒绝（digest 匹配）
- 语义近似的记录会被拒绝（关键词重叠 ≥ 70%）

无需手动检查，直接调用即可。

## loaded-skill 记录（可选）

如需为审计留痕，可运行 `redtrace-skill track-load <canonical-id>` 记录本次实际加载的 Skill。该记录仅用于 Debug / Audit / 分析模型是否频繁向无关 Skill 写经验，不作为学习门禁。

## 禁止

- 不得修改 Skill Memory 索引或 Agent 用户配置
- 不得继续攻击、扫描或扩大任务范围
- 不得创建新的 Agent Session 或 Worker

## 控制权

完成经验判断和必要的 `redtrace-skill learn` 后，将控制权交还当前任务。
不得覆盖、替代或修改当前任务的最终输出协议。
