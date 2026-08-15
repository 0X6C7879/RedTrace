# AI 提示注入（Python）

## 结论判断标准

| 结论 | 判定条件 |
|------|---------|
| vulnerability | 用户输入直接拼接到 LLM Prompt，无过滤 |
| risk-a | 无 HTTP 入口可达的 Prompt 注入风险 |
| risk-b | 有过滤但实现薄弱 |
| safe | 有完善的 Prompt 隔离或白名单 |
| unknown | 无法判断 Prompt 构造方式 |

## 常见漏洞/风险类型

- 模式1：用户输入直接拼接到 system_message
- 模式2：Chat Completion 无角色隔离
- 模式3：Prompt 模板注入
- 模式4：LangChain chain 注入

## 常见安全类型

- Prompt 模板化（固定结构）
- 用户输入角色隔离
- 输入白名单/黑名单过滤
- LLM 输出过滤

## 关键 Sink 点列表

| Sink 点 | 说明 |
|---------|------|
| prompt / system_message | LLM 输入 |
| chat_completion | LLM API 调用 |
| openai / langchain | LLM 库 |

## 检测命令

```bash
# 检测 LLM 相关代码
grep -rn "prompt\|system_message\|chat_completion\|openai\|langchain" --include="*.py"
```

## 常见误判场景

| 场景 | 正确判定 |
|------|---------|
| 内部工具调用 LLM | risk-a |
| 用户输入仅为参数值 | 需进一步分析 |

## 质量检查门禁

- [ ] 确认 LLM API 调用方式
- [ ] 追踪用户输入来源
- [ ] 检查 Prompt 构造逻辑

## 工程约束（禁止清单）

- 禁止假设 LLM API 安全
- 禁止忽略 Prompt 模板
