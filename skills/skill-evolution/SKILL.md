---
name: skill-evolution
description: Review verified outcomes and evolve Skills with reusable learnings from the current session.
---

# Skill Evolution

任务中产生经验证、可复用的新经验时加载本 Skill。

## 写入目标（重要）

经验应写入**产生该经验的专业 Skill**（本次实际加载并使用过的专业 Skill）。

- 默认只 `learn` 专业 Skill，例如 `learn api-security`
- **不要默认 `learn skill-evolution`**：除非当前任务本身就是优化 Skill Evolution 机制，否则不要将普通专业经验写入 `skill-evolution`
- `learn()` 对未加载的 Skill fail-closed：只有本次实际加载并通过 `track-load` 记录的专业 Skill 才能写入经验

## 新经验判定

同时满足以下条件：

- **可复用**：不绑定特定项目/题目/目标，适用于同类场景
- **已验证**：基于本次实际执行并确认的结果，非猜测或理论推导
- **非项目事实**：不是当前目标的特有信息（IP、端口、flag、凭据等）
- **适用 Skill**：适用于本次实际加载过的专业 Skill

## 行动

### 1. Recall

加载后先运行 `redtrace-skill recall <canonical-id>` 消费已有经验，避免重复记录。

### 2. 写入经验

若判定有新经验：

1. 对本次任务中**实际加载并使用过**的专业 Skill，运行 `redtrace-skill track-load <canonical-id>` 记录加载（每个 Skill 一次）
2. 在当前 Workspace 写一份脱敏说明文件
3. 运行 `redtrace-skill learn <canonical-id> --summary <摘要> --evidence <验证依据> --content-file <文件>`

参数要求：
- `--summary`：一行概括，不超过 240 字符
- `--evidence`：验证依据，不超过 500 字符
- `--content-file`：脱敏后的详细说明，不超过 16KB

### 3. 无新经验

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

## Skill 更新条件

当 Memory 中积累了足够多相关经验（≥3 条），且这些经验可以提炼为通用规则时，可考虑更新 Skill 本体。

更新方式：直接编辑 Skill 的 SKILL.md 文件，将经验总结为规则。

## 禁止

- 不得修改 Skill Memory 索引或 Agent 用户配置
- 不得继续攻击、扫描或扩大任务范围
- 不得创建新的 Agent Session 或 Worker

## 控制权

完成经验判断和必要的 `redtrace-skill learn` 后，将控制权交还当前任务。
不得覆盖、替代或修改当前任务的最终输出协议。
