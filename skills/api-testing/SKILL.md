---
name: api-testing
description: API security testing 接口安全测试：REST/GraphQL 面发现、认证与 JWT 操纵、mass assignment、动词篡改、限流、GraphQL introspection。Use this skill when user mentions API 测试, 接口测试, REST, GraphQL, swagger, JWT, or needs to test backend API endpoints and tokens.
---

# API 安全测试

## RedTrace Workflow

1. 读取当前 Step 的 FGS 契约及引用证据，复用同题已验证身份、Session、地址与已有成果。
2. 用 `http_batch` 保存基线与变体请求；通过返回的 Session Resource 和 Request ID 调用 `http_replay`。请求默认并发；只有测试需要身份或状态隔离时才创建独立 Session。需要前序登录结果的请求，待登录完成后再发。
3. 需要爬取、fuzz 或专用协议时，用 `bash` 运行现有 `curl`、`ffuf`、`sqlmap` 或本 Skill 脚本；真实浏览器交互使用 `playwright-skill` 的脚本和独立 BrowserContext，不假定存在浏览器专用工具。显式向命令传递已验证 Cookie/Authorization，不假定 HTTP Resource 会自动向外部工具导出会话。
4. 同一 Step 内并发测试独立输入；跨题调度交给 Commander；仅 General 可通过 legion_spawn 委派同题小队，Soldier/Scout 不自行派生 Agent。复用下方 Payload、打法和 references，按实际反馈深入验证。
5. 保存完整请求/响应、对照与实际影响到证据文件。确认关键结论后 `submit_fact({description,evidence:[{description,path}]})`；真实可交付漏洞再 `submit_finding({title,description,factIds})` 引用 Fact。线索不冒充已确认漏洞。
6. 当前 Step 结束前至少提交一条真实证据支持的汇总 Fact；无突破则如实汇总验证范围、失败或阻塞，再 `finish_step({summary})`。普通局部观察先留在证据文件。


---

## Methodology

### 1. 面发现

| 来源 | 位置 |
|------|------|
| 文档 | `/swagger` `/swagger.json` `/openapi.json` `/api-docs` `/v1|v2|v3/` `/graphql` |
| 被动 | 浏览器 `requests` 记录、前端 JS bundle 里的硬编码端点 |
| 主动 | `recon-dir-scan` 的 `api-endpoints.txt`；ffuf 参数枚举 |

### 2. 认证与会话

- **JWT**：解码看 alg/claims → `alg: none` 与弱密钥（`jwt-tool`/hashcat 离线爆破）、claim 篡改（sub/role/exp）重放
- **令牌泄露**：token 在 URL（进日志/Referer）、前端 JS 硬编码的 API key、localStorage 里的长期 token（`storage` action 直接看）
- **令牌作用域**：用户 token 访问管理 API、登出后 token 仍有效、刷新令牌无轮换

### 3. 逻辑类

- **Mass assignment**：资料/注册接口追加 `{"role":"admin"}` `{"isVip":true}` 类字段
- **动词篡改**：`GET`→`POST`/`PUT`/`DELETE`/`PATCH`；`GET /api/users` 改 `GET /api/users/admin`
- **BOLA/越权**：对象 ID 替换重放（详见 `exploit-authz`——API 越权的高发区）
- **错误信息**：栈迹/SQL 片段/内部字段名泄露

### 4. GraphQL 专项

- Introspection 开放 → 全 schema 导出（`evaluate` 一段 query 即可）
- 字段建议错误信息枚举（typo 提示逐字母还原隐藏字段/mutation）
- Mutation 的对象 ID 越权（与 REST BOLA 同理）
- 查询深度/批量（batching）滥用——仅验证存在性，不施压

### 5. 限流与滥用

- 登录/验证码/敏感操作端点连续请求观察限流（无限流=暴力破解面，记录 finding）
- 批量枚举控制速率与并发，不发起拒绝服务级别的压力

---

## Testing Checklist

- [ ] 浏览器全功能走查，`requests` 收集 API 面
- [ ] 文档端点探测（swagger/openapi/graphql）
- [ ] JWT 解码与篡改重放、token 泄露位置
- [ ] Mass assignment、动词篡改
- [ ] 对象级越权（交叉 exploit-authz 打法）
- [ ] GraphQL：introspection/字段建议/mutation 越权
- [ ] 限流验证
- [ ] 每个确认点：`http_batch` 归档的请求/响应文件 + `submit_fact` 后 `submit_finding`

---

## 相关 Skills

`exploit-authz`（越权/BOLA 深入打法）、`exploit-oauth`（OAuth 流程与 JWT 深度）、`recon-dir-scan`（端点发现）、`exploit-sqli`（注入类 API 参数）、`results-storage`（findings 持久化机制）

## 深度参考

- `references/api-gateway.md`——API 网关安全测试（限流绕过、路由/鉴权层缺陷、网关特有攻击面）
- `references/graphql-deep.md`——GraphQL 深度手册（introspection、字段建议枚举、batching/深度滥用、权限边界）
