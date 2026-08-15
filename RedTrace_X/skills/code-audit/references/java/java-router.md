# Java 语言路由配置

Java 语言特定的模式映射和检测规则。

## 语言元信息

| 字段 | 值 |
|------|-----|
| 语言名称 | Java |
| 语言代码 | `java` |
| Phase | Phase 1 (已完成) |
| 支持框架 | Spring Boot, gRPC (KESS-RPC) |
| 文件扩展名 | `.java`, `.xml`, `.proto` |

---

## 模式关键词到漏洞类型映射

> 「漏洞类型」列的值必须严格使用 `references/common/category-enum.md` 中定义的标准化枚举值。

| 模式关键词 | 漏洞类型 | 规则文档 |
|-----------|---------|---------|
| **SQL关键字（查询）**: SELECT, FROM, WHERE, JOIN, INNER, LEFT, RIGHT, OUTER, ON, GROUP BY, ORDER BY, HAVING, LIMIT, OFFSET | SQLi | java-sql-injection.md |
| **SQL关键字（修改）**: INSERT, UPDATE, DELETE, SET, VALUES, INTO | SQLi | java-sql-injection.md |
| **SQL关键字（结构）**: CREATE, ALTER, DROP, TABLE, INDEX, VIEW, DATABASE, SCHEMA | SQLi | java-sql-injection.md |
| **SQL关键字（控制）**: UNION, CASE, WHEN, THEN, ELSE, END, EXISTS, IN, LIKE, BETWEEN | SQLi | java-sql-injection.md |
| **SQL关键字（函数）**: COUNT, SUM, AVG, MAX, MIN, DISTINCT, AS | SQLi | java-sql-injection.md |
| **SQL执行方法**: executeQuery, executeUpdate, execute, createNativeQuery, nativeQuery, query, executeSql | SQLi | java-sql-injection.md |
| **拼接操作符**: +, +=, concat, join | SQLi | java-sql-injection.md |
| **构造器模式**: StringBuilder, StringBuffer, .append( | SQLi | java-sql-injection.md |
| **格式化方法**: String.format(, .formatted(, MessageFormat | SQLi | java-sql-injection.md |
| **动态替换**: .replace(, .replaceAll(, .replaceFirst( | SQLi | java-sql-injection.md |
| apply, KwaiSQL, ClickHouse, AdReport | SQLi | java-sql-injection.md |
| Runtime.exec, ProcessBuilder, getRuntime, ScriptEngine, GroovyShell | RCE | java-rce.md |
| parseExpression, Ognl.getValue, MVEL.eval, JexlEngine, InitialContext, JndiLookup | RCE | java-rce.md |
| Class.forName, getMethod, invoke, reflect | RCE | java-rce.md |
| HttpClient, RestTemplate, OkHttp, new URL(, URI.create, WebClient, Jsoup.connect | SSRF | java-ssrf.md |
| ImageIO.read(URL), new Socket( | SSRF | java-ssrf.md |
| getWriter, print(, response.getWriter, getOutputStream | XSS | java-xss.md |
| new File(, Paths.get, FileInputStream, Files.read, getOriginalFilename | PathTraversal | java-path-traversal.md |
| ZipInputStream, entry.getName | PathTraversal | java-path-traversal.md |
| MultipartFile, transferTo, getOriginalFilename, BlobStore.upload, BS3Client.putObject, FileUploadChecker, ImageIO.read, ALLOWED_EXTENSIONS | FileUpload | java-file-upload.md |
| DocumentBuilder, SAXParser, XMLReader, DocumentBuilderFactory | XXE | java-xxe.md |
| ObjectInputStream, readObject, readUnshared, XMLDecoder, Yaml.load, SnakeYAML, JSON.parseObject, JSON.parse, Fastjson, XStream, fromXML, fromJSON, ObjectMapper.enableDefaultTyping | Deserialization | java-deserialization.md |
| @PathVariable, userId, orderId, getId | IDOR | java-idor.md |
| PhotoAuthor, PhotoUrl, FeedView, PhotoRequestOption, feedViewServiceRpcClient, photoId, getPhotoUrl, getPhoto, batchGetPhoto | PrivateVideo | java-private-video.md |
| PhotoAuthorService, getAuthorAllPhotoByTime, getAuthorRecentAllPhotoId, getAuthorAllPhotoIdByCursor, getAuthorAllPhotoIdAfter, getAuthorAllPhotoIdAfterTime, getPhotoIdsWithDeleted, getPhotoIdsWithoutDeleted, getAuthorPrivatePhotoByTime, getAuthorPhotoIdByCursor, PhotoStatusQuery, friendTabRemovedUserClient, getBeReverseRemovedUser, SimpleFeedUtils.filterFeed, FeedUtils.filterFeed, enable_feed_filter, setEnableFeedFilter | PrivateAccount | java-private-account.md |
| sendRedirect, setHeader("Location", | OpenRedirect | java-open-redirect.md |
| @CrossOrigin, Access-Control-Allow-Origin, setAllowCredentials, addAllowedOrigin, corsConfigurationSource, addCorsMappings | CORS | java-cors.md |
| "password", "token", "apiKey", "secret", "credential", private static final String = | Hardcoded | java-hardcoded.md |
| @RequestMapping 无认证注解, FilterChain 缺失, permitAll, SecurityConfig 跳过认证, 签名绕过, @PreAuthorize hasRole 错误, @RolesAllowed 缺失, 角色检查缺失, 垂直越权, 全局越权 | BrokenAccessControl | java-broken-access-control.md |
| 敏感删改接口无 CSRF Token, @PutMapping/@DeleteMapping 无 csrf 校验, Stateless 无 CSRF 防护 | CSRF | java-csrf.md |
| prompt, system_message, chat_completion, user_input → LLM 调用 | PromptInjection | java-prompt-injection.md |
| 金额篡改, 数量篡改, 状态机绕过, 业务流程跳步, 评分/投票滥用 | BusinessLogic | java-business-logic.md |
| 分页查询无上限, export, downloadAll, listAll, findAll 无 limit | BatchExport | java-batch-export.md |
| @EnableSwagger2, Docket, @OpenAPIDefinition, springfox, springdoc, knife4j, swagger-ui, api-docs, doc.html | SwaggerMisconfig | java-swagger-misconfig.md |

---

## 公司内部 SDK 映射

| SDK/组件 | 危险方法 | 漏洞类型 | 说明 |
|---------|----------|----------|------|
| KwaiSQL | `execute(String sql)` | SQLi | 动态 SQL 执行 |
| KwaiSQL | `apply(String field, Object value)` | SQLi | 字段名拼接 |
| ClickHouse | `execute(String sql)` | SQLi | 动态 SQL 执行 |
| AdReport | `query(String jsonCondition)` | SQLi | JSON 条件拼接 |
| AdReport | `JSON_EXTRACT(extra_data, '$.' + field)` | SQLi | JSON 路径注入 |
| PhotoServiceRpcClient | `getPhoto(photoId)` / `batchGetPhoto(ids)` | PrivateVideo | 获取视频信息，需检查公开状态 |
| PhotoUrlServiceRpcClient | `getPhotoUrl(photoId)` | PrivateVideo | 获取视频URL，可能泄露隐私视频链接 |
| FeedViewServiceRpcClient | `renderFeedView(request)` | PrivateVideo | Feed流渲染，未过滤可能包含隐私视频 |
| PhotoAuthorServiceRpcClient | `getPhotoAuthor(photoId)` | PrivateVideo | 获取视频作者，配合校验使用 |
| PhotoAuthorServiceRpcClient | `getAuthorAllPhotoByTime` / `getAuthorRecentAllPhotoId` / `getAuthorAllPhotoIdByCursor` / `getAuthorAllPhotoIdAfter` / `getAuthorAllPhotoIdAfterTime` / `getPhotoIdsWithDeleted` / `getPhotoIdsWithoutDeleted` / `getAuthorPrivatePhotoByTime` / `getAuthorPhotoIdByCursor` | PrivateAccount | 获取用户所有视频ID（含私密账号），需校验不让ta看 + filterFeed |
| PhotoAuthorServiceRpcClient | `getAuthorPublicPhotoByTime` / `getAuthorRecentPublicPhotoId` / `getAuthorPublicPhotoIdByCursor` / `getAuthorPublicPhotoIdAfter` | PrivateAccount | 获取公开视频ID，但私密账号的公开视频仍需私密账号校验 |
| friendTabRemovedUserClient | `getBeReverseRemovedUser` | PrivateAccount | 不让ta看校验（防御方法） |
| SimpleFeedUtils / FeedUtils | `filterFeed` | PrivateAccount | 视频权限过滤（防御方法） |

---

## 高危参数名列表

以下参数名如果直接拼接到 SQL/命令中，属于高风险：

| 参数名 | 常见用途 | 风险类型 |
|--------|----------|----------|
| `searchField`, `fieldName`, `columnName` | 动态字段查询 | SQLi |
| `sortBy`, `orderField`, `sortColumn` | 排序字段 | SQLi |
| `tableName` | 动态表名 | SQLi |
| `condition`, `whereClause` | WHERE 条件 | SQLi |
| `matchField`, `jsonPath` | JSON 路径 | SQLi |
| `command`, `cmd`, `bash` | 命令执行 | RCE |
| `url`, `targetUrl`, `callbackUrl` | URL 请求 | SSRF |
| `redirectUrl`, `returnUrl`, `next` | 重定向 | OpenRedirect |
| `filename`, `filepath`, `path` | 文件操作 | PathTraversal |

---

## HTTP 入口点识别规则

| 类型 | 识别模式 | 规则文档 |
|------|----------|----------|
| REST Controller | `@RestController`/`@Controller` + `@XxxMapping` | framework-spring.md |
| gRPC Service | `@KrpcService`/`@GrpcService` + extends `XxxImplBaseV2` | grpc.md |

**参数来源**：
| 类型 | 参数来源 |
|------|----------|
| REST | @RequestParam, @PathVariable, @RequestBody |
| gRPC | RPC 方法参数 |

---

## 支持的漏洞类型列表

| 类型 | 规则文档 |
|------|----------|
| SQL 注入 | java-sql-injection.md |
| RCE | java-rce.md |
| SSRF | java-ssrf.md |
| XSS | java-xss.md |
| 路径遍历 | java-path-traversal.md |
| 文件上传 | java-file-upload.md |
| XXE | java-xxe.md |
| 反序列化 | java-deserialization.md |
| IDOR | java-idor.md |
| 隐私视频越权 | java-private-video.md |
| 私密账号越权 | java-private-account.md |
| 开放重定向 | java-open-redirect.md |
| CORS | java-cors.md |
| 硬编码凭据 | java-hardcoded.md |
| Swagger 不安全配置 | java-swagger-misconfig.md |

