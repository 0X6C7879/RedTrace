# 批量导出/批量操作无限制（JavaScript）

## 结论判断标准

| 结论 | 判定条件 |
|------|---------|
| vulnerability | 批量接口无分页/无上限，可导致资源耗尽 |
| risk-a | 无 HTTP 入口可达的批量导出风险 |
| risk-b | 有上限但设置过大 |
| safe | 有合理的分页和上限控制 |
| unknown | 无法判断批量操作限制 |

## 常见漏洞/风险类型

- 模式1：分页查询无 limit 或 limit 无上限
- 模式2：export/download 接口无数量限制
- 模式3：findAll/listAll 无分页

## 常见安全类型

- 分页查询（limit + offset）
- 上限控制（maxResults）
- 流式导出
- 异步导出

## 关键 Sink 点列表

| Sink 点 | 说明 |
|---------|------|
| findAll / listAll | 无限制查询 |
| export / download | 批量导出接口 |
| limit / offset | 分页参数 |

## 检测命令

```bash
# 检测无限制查询
grep -rn "findAll\|listAll\|getAll" --include="*.js"

# 检测导出接口
grep -rn "export\|download\|Export\|Download" --include="*.js"
```

## 常见误判场景

| 场景 | 正确判定 |
|------|---------|
| 有分页参数且有上限 | safe |
| 管理后台批量操作 | risk-b |

## 质量检查门禁

- [ ] 确认是否有分页参数
- [ ] 检查 limit 上限
- [ ] 确认导出接口限制

## 工程约束（禁止清单）

- 禁止假设分页默认值
- 禁止忽略上限配置
