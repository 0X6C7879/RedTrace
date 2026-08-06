# 漏洞类型枚举定义（category）

**强制约束**：`category` 字段的值必须严格等于下方表格「枚举值」列中的值。**禁止**使用别名、翻译、变体或自创名称。

---

## 标准枚举值

| 枚举值 | 中文说明 |
|--------|---------|
| `SQLi` | SQL 注入 |
| `NoSQLi` | NoSQL 注入 |
| `RCE` | 远程代码执行 |
| `SSRF` | 服务器端请求伪造 |
| `XSS` | 跨站脚本攻击 |
| `PathTraversal` | 路径遍历 |
| `FileUpload` | 文件上传 |
| `XXE` | XML 外部实体注入 |
| `Deserialization` | 反序列化 |
| `OpenRedirect` | 开放重定向 |
| `CORS` | 跨域资源共享 |
| `Hardcoded` | 硬编码凭据 |
| `IDOR` | 不安全的直接对象引用 |
| `PrivateVideo` | 隐私视频越权 |
| `PrivateAccount` | 私密账号越权（访问私密账号视频/绕过不让ta看/获取隐私视频） |
| `SSTI` | 服务端模板注入 |
| `FormatString` | 格式化字符串 |
| `WebEnableDebug` | Web 调试模式启用 |
| `IntegerOverflow` | 整数溢出 |
| `WeakRNG` | 弱随机数生成 |
| `PrototypePollution` | 原型污染 |
| `JWT` | JWT 相关漏洞 |
| `BrokenAccessControl` | 访问控制缺失/越权/未授权/权限绕过 |
| `CSRF` | 跨站请求伪造 |
| `PromptInjection` | AI 提示注入 |
| `BusinessLogic` | 业务逻辑漏洞 |
| `BatchExport` | 批量导出/批量操作无限制 |
| `LDAPi` | LDAP 注入 |
| `JDBCi` | JDBC URI 注入 |
| `XPathInjection` | XPath 注入 |
| `CRLFi` | CRLF/HTTP 响应头注入 |
| `GraphQLi` | GraphQL 注入/越权 |
| `SwaggerMisconfig` | Swagger/OpenAPI 不安全配置 |
