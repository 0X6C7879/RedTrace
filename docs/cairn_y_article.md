# AI 自动化渗透架构 Cairn 满分登顶 TsecBench Cybench —— 众人向左，我偏向右

> 原始来源：https://mp.weixin.qq.com/s/ZzKF_0MOb0cak9izhHqCUQ  
> 公开镜像：https://l3yx.github.io/2026/08/30/AI-%E8%87%AA%E5%8A%A8%E5%8C%96%E6%B8%97%E9%80%8F%E6%9E%B6%E6%9E%84-Cairn-%E6%BB%A1%E5%88%86%E7%99%BB%E9%A1%B6-TsecBench-Cybench-%E2%80%94%E2%80%94-%E4%BC%97%E4%BA%BA%E5%90%91%E5%B7%A6%EF%BC%8C%E6%88%91%E5%81%8F%E5%90%91%E5%8F%B3/  
> 日期：2026-08-30  
> 说明：以下为依据公开网页整理的 Markdown 结构化摘要，非逐字转载。

## 前言

Cairn_Y 是在 Cairn 基础上继续演进的 AI 自动化渗透测试引擎。作者强调，它的提升重点不在针对特定靶场设计提示词、内嵌答案或跨题记忆，而主要来自 Harness 层面的工程改进。

文章称 Cairn_Y 在 Cybench、TsecBench v1 和 XBOW Validation Benchmarks 等评测中取得领先成绩，并强调评测过程公开模型调用记录，以便外部检查。

## 从 Cairn 架构说起

Cairn 最初来自腾讯第二届 TCH 智能渗透挑战赛。其核心思想不是堆叠大量领域组件，而是把渗透过程抽象为一个目标导向的状态空间搜索问题。

Cairn 的代表性设计包括：

- 意图工程；
- 共享黑板；
- Agent 间接协调；
- Fact-Intent DAG；
- 状态空间搜索；
- 尽量减少系统约束，释放基础模型本身的推理能力。

其架构刻意保持极简：

- 不依赖大量 Security Skill；
- 不引入领域 RAG；
- 不依赖 MCP 工具体系；
- 不预定义固定渗透攻击流程；
- 不把不同攻击阶段硬编码为一组专业 SubAgent。

作者认为，Cairn 更像一次对“极简 Harness + 外化状态”的工程实验，而不是传统意义上的功能完整渗透平台。

## Cairn_Y 方案

Cairn_Y 延续 **Less Is More** 的设计方向。与当前常见的“跨题学习、幻觉门控、大量工具、专业 SubAgent、Security Skill”路线不同，它继续把重点放在状态表达、任务推进和 Agent Loop 本身。

### FGS 图：外化记忆与世界状态

Cairn_Y 将原来的图结构进一步整理为 **FGS（Fact-Goal-Step）图**。

- **Fact**：已经得到确认的事实，表示当前世界状态。
- **Goal**：任务的完成条件，即搜索终止条件；同时允许动态增加或删除 Sub Goal。
- **Step**：下一步行动，用来描述如何基于当前事实产生新的事实，并推动状态继续演化。

FGS 图本质上承担了系统的共享记忆和任务状态存储。Agent 不需要依赖长期对话记忆来记住整个任务过程。

### Decide & Execute：两类运行活动

系统主要只有两类活动：**Decide** 与 **Execute**。它们不是固定角色的 SubAgent，而更像同一个 Agent Loop 在不同阶段装载不同 Prompt 和 Tool。

#### Decide

Decide 负责：

- 查看和修改 FGS 图；
- 分析当前任务状态；
- 创建、废弃或重新排序 Step；
- 创建或删除 Sub Goal；
- 在任务状态发生变化时重新规划。

Decide 通常串行运行，每次触发都从干净上下文开始，不依赖自身上一轮会话记忆。

#### Execute

Execute 负责实际改变外部世界状态，例如：

- `read`
- `bash`
- `edit`
- `write`

同时，它可以通过类似 `submit_fact` 的工具把执行结果写回 FGS 图。

因此，Decide 和 Execute 之间真正共享的长期状态不是聊天上下文，而是 FGS 图。

## Finding：搜索过程的结构化产物

Cairn_Y 进一步引入了 **Finding**。

作者认为，CTF 的最终目标通常就是拿到 Flag，因此“搜索终点”和“任务产物”往往是一致的；但在渗透测试和代码审计中，最终任务目标可能是“完成测试”，真正需要交付的却是搜索过程中发现的漏洞。

因此：

- **Goal** 描述任务最终何时结束；
- **Fact** 描述已经确认的世界状态；
- **Finding** 描述搜索过程中真正值得交付的成果。

对于漏洞挖掘场景，Finding 可以直接定义为安全漏洞，并承载对应发现结果。

## 工程选型

Cairn_Y 在工程实现上也继续追求可控和轻量：

- Agent Loop 不再直接依赖 Claude Code 或 Codex 这类完整 Agent 产品；
- 当前主要使用 PI 提供的 Agent Loop 能力；
- 选择 PI 的原因不是其功能更多，而是实现更轻、更容易控制；
- 作者后续甚至倾向完全自研 Agent Loop；
- 技术栈从 Python 转向 Node，以便更贴近 Claude Code、Codex、PI 等 Agent 工具生态；
- 后续仍考虑使用 Go 或 Rust 实现更轻量的版本；
- 内置 Prompt 很短，并且不与网络安全任务强耦合，因此 Cairn_Y 仍被定位为通用任务求解引擎，而不是只服务于渗透测试。

## 核心设计结论

文章最终表达的观点可以概括为：

1. 渗透测试可以被视为一个目标导向的状态空间搜索问题。
2. 任务状态应尽量外化，而不是依赖 Agent 隐式记忆。
3. FGS 图既是共享黑板，也是系统的外部记忆。
4. Decide 负责规划，Execute 负责改变世界状态并产生 Fact。
5. Finding 将“任务结束条件”和“搜索过程中的有效成果”分离。
6. Agent Harness 越复杂不一定越强，过度堆叠 Skill、SubAgent、工具和约束可能反而降低模型能力。
7. 系统真正的核心竞争力仍然是基础模型本身，Harness 的价值更多是让模型稳定、高效地发挥能力。

## 成本与趋势

文章还提到，TsecBench v1 包含大量题目和 Flag。相比早期比赛中较高的完整求解成本，Cairn_Y 的运行成本已经显著下降。

作者据此判断，随着模型能力、Harness 工程和本地模型继续进步，自动化渗透测试的单位成本可能快速下降，并进一步改变网络安全攻防的成本结构。

---

## Cairn_Y 运行逻辑简图

```text
任务开始 / FGS 图发生变化
          │
          ▼
       Decide
          │
          ├── 读取 Fact / Goal / Step
          ├── 判断当前状态
          ├── 新增 / 删除 Sub Goal
          └── 新增 / 废弃 / 调整 Step
          │
          ▼
       Execute
          │
          ├── 读取 FGS 图
          ├── 调用 bash/read/edit/write 等工具
          └── submit_fact
          │
          ▼
      新 Fact 写入 FGS
          │
          └──────────► 再次触发 Decide

搜索过程中：
Fact     = 已确认世界状态
Goal     = 完成条件
Step     = 下一步因果行动
Finding  = 最终需要交付的搜索成果
```
