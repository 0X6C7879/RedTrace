---
name: api-authorization-and-bola
description: API 对象 ID、嵌套资源、隐藏可写字段或函数权限薄弱时，定向验证 BOLA/BFLA、动词滥用及 mass assignment。
---

# API 授权：BOLA / BFLA / Mass Assignment

## 验证循环

1. 建立测试账号 A/B。
2. 以 A 捕获创建、读取、更新、删除请求，再用 B 的 token 对照重放。
3. 检查同级/嵌套端点、替代 HTTP 动词及角色敏感函数。

| 测试面 | 示例 |
|---|---|
| 对象读取 | `/api/v1/orders/123` |
| 嵌套对象 | `/api/v1/users/1/invoices/9` |
| 管理/内部函数 | `/api/v1/admin/users` |
| 修改路径 | `PUT`、`PATCH`、`DELETE` |
| 隐藏 JSON 字段 | `role`、`org`、`verified`、`tier` |

```json
{"role":"admin"}
{"isAdmin":true}
{"org":"target-company"}
{"verified":true}
```

别漏查 Header/Cookie/GraphQL 参数和嵌套对象中的 ID、同路由弱鉴权动词、只验父资源未验子资源、管理文档暴露的额外可写字段。

JWT/token 及更广泛 IDOR 路径见 [认证与访问控制](../auth-access-control/SKILL.md)；GraphQL/隐藏参数发现见 [API 测试](../api-testing/SKILL.md)。
