# 业务逻辑漏洞（Java）

## 结论判断标准

| 结论 | 判定条件 |
|------|---------|
| vulnerability | 业务流程可被绕过或滥用 |
| risk-a | 无 HTTP 入口可达的业务逻辑风险 |
| risk-b | 有部分校验但不完善 |
| safe | 有完善的业务规则校验 |
| unknown | 无法判断业务逻辑状态 |

## 常见漏洞/风险类型

- 模式1：金额/数量篡改（前端可控）
- 模式2：状态机绕过（跳过中间状态）
- 模式3：评分/投票滥用
- 模式4：业务流程跳步

## 常见安全类型

- 服务端金额计算
- 状态机完整性校验
- 频率限制
- 业务规则服务端校验

## 关键 Sink 点列表

| Sink 点 | 说明 |
|---------|------|
| amount / quantity | 金额/数量参数 |
| status / state | 状态参数 |
| score / rating | 评分参数 |

## 检测命令

```bash
# 检测金额/数量参数
grep -rn "amount\|quantity\|price\|score" --include="*.java" | grep "RequestParam\|PathVariable"

# 检测状态参数
grep -rn "status\|state" --include="*.java" | grep "RequestParam\|PathVariable"
```

## 常见误判场景

| 场景 | 正确判定 |
|------|---------|
| 只读业务参数 | safe |
| 服务端计算的金额 | safe |

## 质量检查门禁

- [ ] 确认参数是否服务端校验
- [ ] 追踪业务流程状态
- [ ] 检查前端可控参数

## 工程约束（禁止清单）

- 禁止假设业务逻辑正确
- 禁止忽略状态机
