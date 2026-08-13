# JavaScript 语言路由配置

JavaScript/TypeScript 语言特定的模式映射和检测规则。

## 质量检查门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 模式关键词到漏洞类型映射已正确识别
- [ ] HTTP 入口点识别规则已应用
- [ ] 检测命令执行结果已验证
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**

---

## 工程约束（禁止清单）

**禁止操作**:
- 禁止假设关键词自动等于漏洞（需数据流分析）
- 禁止假设所有 HTTP 入口都用户可控
- 禁止跳过数据流追踪直接判定

**推荐做法**:
- 使用 grep 命令确认代码实现
- 追踪完整调用链路
- 记录代码文件路径和行号作为证据

---

## 语言元信息

| 字段 | 值 |
|------|-----|
| 语言名称 | JavaScript / TypeScript |
| 语言代码 | `javascript` |
| Phase | Phase 1 (已完成) |
| 支持框架 | Express, Koa, NestJS, Egg.js |
| 文件扩展名 | `.js`, `.ts`, `.jsx`, `.tsx` |

---

## 模式关键词到漏洞类型映射

> 「漏洞类型」列的值必须严格使用 `references/common/category-enum.md` 中定义的标准化枚举值。

| 模式关键词 | 漏洞类型 | 规则文档 |
|-----------|---------|---------|
| `eval(`, `new Function(`, `setTimeout(字符串)`, `setInterval(字符串)` | RCE | javascript-rce.md |
| `child_process.exec(`, `child_process.execSync(`, `require('child_process')` | RCE | javascript-rce.md |
| `vm.runInNewContext(`, `vm.runInThisContext(`, `vm.Script(` | RCE | javascript-rce.md |
| **SQL关键字（查询）**: SELECT, FROM, WHERE, JOIN, INNER, LEFT, RIGHT, OUTER, ON, GROUP BY, ORDER BY, HAVING, LIMIT, OFFSET | SQLi | javascript-sql-injection.md |
| **SQL关键字（修改）**: INSERT, UPDATE, DELETE, SET, VALUES, INTO | SQLi | javascript-sql-injection.md |
| **SQL关键字（结构）**: CREATE, ALTER, DROP, TABLE, INDEX, VIEW, DATABASE, SCHEMA | SQLi | javascript-sql-injection.md |
| **SQL关键字（控制）**: UNION, CASE, WHEN, THEN, ELSE, END, EXISTS, IN, LIKE, BETWEEN | SQLi | javascript-sql-injection.md |
| **SQL关键字（函数）**: COUNT, SUM, AVG, MAX, MIN, DISTINCT, AS | SQLi | javascript-sql-injection.md |
| **SQL执行方法**: query, execute, .query(, .execute( | SQLi | javascript-sql-injection.md |
| **拼接操作**: +, +=, `${}`, .concat( | SQLi | javascript-sql-injection.md |
| **动态替换**: .replace(, .replaceAll( | SQLi | javascript-sql-injection.md |
| `Sequelize.literal(`, `sequelize.query(`, `knex.raw(` | SQLi | javascript-sql-injection.md |
| `User.find(req.query)`, `User.find(req.body)`, `$where:` | NoSQLi | javascript-nosqli.md |
| `JSON.parse(req.query)`, `JSON.parse(req.body)` | NoSQLi | javascript-nosqli.md |
| `axios.get(`, `axios.post(`, `got(`, `node-fetch` | SSRF | javascript-ssrf.md |
| `http.get(`, `https.request(`, `http.request(` | SSRF | javascript-ssrf.md |
| `innerHTML`, `document.write(`, `outerHTML` | XSS | javascript-xss.md |
| `dangerouslySetInnerHTML`, `v-html` | XSS | javascript-xss.md |
| `<%- ` (EJS), `!{}` (Pug) | XSS | javascript-xss.md |
| `cors(`, `Access-Control-Allow-Origin`, `credentials: true` | CORS | javascript-cors.md |
| `fs.readFile(`, `fs.writeFile(`, `res.sendFile(`, `path.join(` | PathTraversal | javascript-path-traversal.md |
| `res.redirect(`, `res.location(`, `window.location.href` | OpenRedirect | javascript-open-redirect.md |
| `Object.assign(`, `_.merge(`, `__proto__`, `constructor.prototype` | PrototypePollution | javascript-prototype-pollution.md |
| `unserialize(`, `deserialize(`, `msgpack.loads(`, `msgpack.decode(` | Deserialization | javascript-deserialization.md |
| `multer(`, `upload(`, `formidable(`, `busboy` | FileUpload | javascript-file-upload.md |
| `libxmljs.parseXml(`, `xmldom.parseFromString(`, `xml2js.parseString(` | XXE | javascript-xxe.md |
| `jwt.sign(`, `jwt.verify(`, `jsonwebtoken` | JWT | javascript-jwt.md |
| `password`, `token`, `apiKey`, `secret`, const = | Hardcoded | javascript-hardcoded.md |
| 认证中间件缺失, `router.use(auth)` 缺失, 无认证守卫, 签名绕过, 角色/权限中间件缺失, rbac 缺失, 垂直越权, 全局越权 | BrokenAccessControl | javascript-broken-access-control.md |
| 敏感删改接口无 CSRF Token, `csurf` 中间件缺失 | CSRF | javascript-csrf.md |
| `prompt`, `system_message`, `chat_completion`, `openai`, `langchain`, user_input → LLM | PromptInjection | javascript-prompt-injection.md |
| 金额篡改, 数量篡改, 状态机绕过, 评分滥用 | BusinessLogic | javascript-business-logic.md |
| 分页无上限, `export`, `listAll`, `findAll` 无 limit | BatchExport | javascript-batch-export.md |
| `swagger-ui-express`, `SwaggerModule`, `swaggerUi`, `api-docs`, `@nestjs/swagger`, `DocumentBuilder` | SwaggerMisconfig | javascript-swagger-misconfig.md |

---

## 高危参数名列表

以下参数名如果直接拼接到 SQL/命令中，属于高风险：

| 参数名 | 常见用途 | 风险类型 |
|--------|----------|----------|
| `searchField`, `fieldName`, `columnName` | 动态字段查询 | SQLi / NoSQLi |
| `sortBy`, `orderField`, `sortColumn` | 排序字段 | SQLi / NoSQLi |
| `tableName` | 动态表名 | SQLi |
| `condition`, `whereClause`, `filter` | WHERE 条件 | SQLi / NoSQLi |
| `matchField`, `jsonPath` | JSON 路径 | NoSQLi |
| `command`, `cmd`, `bash` | 命令执行 | RCE |
| `url`, `targetUrl`, `callbackUrl` | URL 请求 | SSRF |
| `redirectUrl`, `returnUrl`, `next` | 重定向 | OpenRedirect |
| `filename`, `filepath`, `path` | 文件操作 | PathTraversal |
| `data`, `payload`, `serialized`, `encoded` | 反序列化数据 | Deserialization |
| `template`, `xml`, `xmlData` | 模板/XML 数据 | SSTI / XXE |

---

## HTTP 入口点识别规则

| 框架 | 识别模式 | 参数来源 |
|------|----------|----------|
| Express | `app.get/post/...`, `router.get/post/...` | `req.query`, `req.params`, `req.body` |
| Koa | `router.get/post/...` | `ctx.query`, `ctx.params`, `ctx.request.body` |
| NestJS | `@Get/@Post/@Controller` | `@Query()`, `@Param()`, `@Body()` |
| Egg.js | `app/router.js` 中 `router.get/post/...` | `ctx.query`, `ctx.params`, `ctx.request.body` |

> **Egg.js 约定优于配置**：Controller 自动加载（`app/controller/{name}.js`），Service 自动加载（`app/service/{name}.js`）。代码中无 require/import 是正常的，框架运行时自动注入，通过 `ctx.service.{name}` 调用。

---

## 支持的漏洞类型列表

| 类型 | 规则文档 |
|------|----------|
| SQL 注入 | javascript-sql-injection.md |
| NoSQL 注入 | javascript-nosqli.md |
| RCE | javascript-rce.md |
| SSRF | javascript-ssrf.md |
| XSS | javascript-xss.md |
| 路径遍历 | javascript-path-traversal.md |
| 开放重定向 | javascript-open-redirect.md |
| CORS | javascript-cors.md |
| 原型污染 | javascript-prototype-pollution.md |
| 反序列化 | javascript-deserialization.md |
| 文件上传 | javascript-file-upload.md |
| XXE | javascript-xxe.md |
| JWT | javascript-jwt.md |
| 硬编码凭据 | javascript-hardcoded.md |
| Swagger 不安全配置 | javascript-swagger-misconfig.md |

---

## 快速检测命令

```bash
# 检测 Express 路由
grep -rn "app\.get\|app\.post\|router\.get\|router\.post" --include="*.js"

# 检测 Koa 路由
grep -rn "router\.get\|router\.post" --include="*.js"

# 检测 NestJS 控制器
grep -rn "@Get\|@Post\|@Controller" --include="*.ts"

# 检测 Egg.js 路由
grep -rn "router\.\(get\|post\|put\|delete\|patch\)" --include="*.js" --include="*.ts" app/router

# 检测用户参数
grep -rn "req\.query\|req\.params\|req\.body" --include="*.js"

# 检测 RCE 模式
grep -rn "eval(\|new Function(\|child_process" --include="*.js"

# 检测 SQLi 模式
grep -rn "sequelize\.literal\|knex\.raw\|\.find(req\.query)" --include="*.js"

# 检测 SSRF 模式
grep -rn "axios\.get\|http\.get\|https\.request" --include="*.js"

# 检测 XSS 模式
grep -rn "innerHTML\|document\.write\|dangerouslySetInnerHTML" --include="*.js" --include="*.jsx"

# 检测 CORS 模式
grep -rn "cors(\|Access-Control-Allow-Origin" --include="*.js"

# 检测反序列化模式
grep -rn "unserialize(\|deserialize(\|msgpack\|node-serialize" --include="*.js"

# 检测文件上传模式
grep -rn "multer(\|formidable(\|busboy\|upload\(" --include="*.js"

# 检测 XXE 模式
grep -rn "libxmljs\|xmldom\|xml2js\|parseXml(\|parseFromString(" --include="*.js"
```
