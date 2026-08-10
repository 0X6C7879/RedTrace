# 误报排除规则

本文档定义应排除的误报类型，明确区分安全漏洞与代码质量/合规问题。

> **规则编号体系**：每条规则赋稳定 `FP-x.y` ID（一、代码质量→`FP-1.x`；二、合规业务→`FP-2.x`；三、安全场景→`FP-3.x`；四、判定流程→`FP-4.x`）。输出时 `passed_checks[*].reason` 必须以 `[FP-x.y]` 或 `[FP-NONE]` 起首。

---

## FP 规则索引（扁平索引）

| FP-id | 类别 | 一句话摘要 | 适用模式 |
|-------|------|-----------|----------|
| FP-1.1 | 代码质量 | 输入验证缺失（类型/长度/格式/非空/NPE） | 全部 |
| FP-1.2 | 代码质量 | 日志与调试信息泄露 | 全部 |
| FP-1.3 | 代码质量 | 错误处理不当（静默吞异常/堆栈泄露） | 全部 |
| FP-1.4 | 代码质量 | 代码健壮性（NPE/资源未关闭/并发/性能/弱随机非安全用途/ReDoS） | 全部 |
| FP-2.1 | 合规业务 | 业务逻辑问题（批量上限/前端验证/优惠券/权限配置） | 全部 |
| FP-2.2 | 合规业务 | 合规规范（SNAPSHOT/postMessage/GDPR/隐私协议） | 全部 |
| FP-2.3 | 合规业务 | API设计（版本/限速/分页/命名/RequestMapping未指定method） | 全部 |
| FP-3.1 | 安全场景 | SSRF误报排除（内网URL/白名单/Kconf/@注入绕过） | api-audit, mr-review, report-review |
| FP-3.2 | 安全场景 | 越权误报排除（S3/RBAC/所有权/不可枚举ID/同租户） | api-audit, mr-review, report-review |
| FP-3.2.1 | 安全场景 | 自己操作自己资源（userId==资源ID+可信来源） | api-audit, mr-review, report-review |
| FP-3.2.2 | 安全场景 | 返回布尔值/统计数据（攻击价值极低） | api-audit, mr-review, report-review |
| FP-3.2.3 | 安全场景 | 已公开数据（搜索可见/无需登录/公开业务信息） | api-audit, mr-review, report-review |
| FP-3.2.4 | 安全场景 | 不可枚举ID类型（BlobStore/UUID/AES/Hash ID，单条查询） | api-audit, mr-review, report-review |
| FP-3.2.5 | 安全场景 | 同租户横向越权（orgId/guildId/teamId相同） | api-audit, mr-review, report-review |
| FP-3.2.6 | 安全场景 | 数据层隐式权限过滤（MyBatis-Plus/JPA lambdaQuery.eq userId） | api-audit, mr-review, report-review |
| FP-3.2.7 | 安全场景 | 全局拦截器/路径白名单隐式认证（WebMvcConfigurer/SecurityFilterChain/needLoginPathList/NestJS APP_GUARD；.redtrace/code-audit/PROJECT_CONTEXT.md仅参考需代码确认） | api-audit, mr-review, report-review, arch-scan |
| FP-3.2.8 | 安全场景 | 页面入口方法IDOR（仅返回视图名String/ModelAndView） | api-audit, mr-review, report-review |
| FP-3.2.9 | 安全场景 | authToken/一次性凭证（shareCode/inviteCode不可枚举） | api-audit, mr-review, report-review |
| FP-3.2.10 | 安全场景 | 身份冒充（用户可控 username → 冒充身份）→ BrokenAccessControl（非 IDOR） | api-audit, mr-review, report-review |
| FP-3.2.11 | 安全场景 | 权限校验被注释/禁用 → BrokenAccessControl（非 IDOR） | api-audit, mr-review, report-review |
| FP-3.3 | 安全场景 | gRPC参数溯源（userId/accountId由网关/拦截器注入） | api-audit, mr-review, report-review |
| FP-3.3.1 | 安全场景 | RPC下游调用误报（传身份凭据→不报；仅传参数→风险-B；SQL拼接→漏洞） | api-audit, mr-review, report-review |
| FP-3.3.2 | 安全场景 | SQL注入类型转换（parseDate/parseInt/UUID/枚举/getOrDefault固定值） | api-audit, mr-review, report-review |
| FP-3.3.3 | 安全场景 | Spring MVC自定义注解注入（@EspAccount/@Visitor/@LoginUser从attribute获取） | api-audit, mr-review, report-review |
| FP-3.3.4 | 安全场景 | ES字段名排序 vs NoSQLi（addSort仅控制排序字段名，无法注入查询逻辑） | api-audit, mr-review, report-review |
| FP-3.3.5 | 安全场景 | 外部依赖拦截器无法读源码 → risk-b（入口可达+防护不明确，非risk-a） | api-audit, mr-review, report-review |
| FP-3.4 | 安全场景 | 配置数据源（Kconf/Apollo/Nacos/env/DB配置/antiSsrfProxiesList） | api-audit, mr-review, report-review |
| FP-3.5 | 安全场景 | 硬编码凭证（测试/配置/示例代码→不报；生产→风险-A） | api-audit, mr-review, report-review |
| FP-3.6 | 安全场景 | 隐私视频误报（SDK后端判断/photoId来自DB/PhotoRequestOption/限非线上） | api-audit, mr-review, report-review |
| FP-3.7 | 安全场景 | 拦截型校验后使用原始变量（validate+return→安全） | api-audit, mr-review, report-review |
| FP-3.8 | 安全场景 | 查询型校验控制流中断（store.get+null check→安全） | api-audit, mr-review, report-review |
| FP-3.9 | 安全场景 | 分支互斥+业务输入限制（安全分支early return+危险分支需特定输入） | api-audit, mr-review, report-review |
| FP-3.10 | 安全场景 | 文件上传无持久化（仅内存解析无落盘sink→排除，转查XXE/反序列化/DoS） | api-audit, mr-review, report-review |
| FP-4.x | 判定流程 | 综合判定流程（代码质量→合规→安全场景逐层过滤） | 全部 |

---

## 常见误报/漏报 Gotchas（最高信号）

| Gotcha | 说明 | 对应规则 |
|--------|------|----------|
| IDOR + UUID + 单条查询 → 不报 | UUID 128bit 不可预测，单条查询无法遍历 | `[FP-3.2.4]` |
| SSRF 只控 path 不控 host → 不报 | 用户输入仅影响 URL 的 path/query，Host 不可控 | `[FP-3.1]` |
| 自动转义框架 XSS 默认不报 | Spring/Thymeleaf 默认 HTML 转义，无拼接则安全 | `[FP-3.1]` |
| 仅缺加固（限流/分页/日志）→ 不报 | 属代码质量或合规，非安全漏洞 | `[FP-1.x]` / `[FP-2.x]` |
| 可信输入作攻击向量 → 不报 | gRPC userId/Kconf URL 等由拦截器注入，用户不可篡改 | `[FP-3.3]` / `[FP-3.4]` |
| ReDoS vs 限速区分 → 不报告 ReDoS | ReDoS 属代码质量；限速缺失属合规，都不报 | `[FP-1.4]` / `[FP-2.3]` |
| 弱随机非安全用途 → 不报 | Random 用于非安全场景（如分片/负载均衡）不算弱随机 | `[FP-1.4]` |
| 不可枚举 ID 类型 → 不报 | BlobStore key/bucket UUID/AES加密参数/Hash ID 不可遍历 | `[FP-3.2.4]` |
| 文件上传仅内存解析不落盘 → 不报（文件上传） | MultipartFile 仅 EasyExcel.read/JSON.parse，无 transferTo/落盘 sink | `[FP-3.10]` |

---

## 核心原则

**代码质量/合规问题不属于安全漏洞范畴，应明确区分并排除。**

安全漏洞的定义：用户输入可通过 HTTP/gRPC 入口到达危险代码片段，无有效防护，导致安全问题。

---

## 一、代码质量问题（不报告）[FP-1.x]

### 1.1 输入验证缺失 [FP-1.1]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| **类型校验缺失** | 不报告 | `username = request.data.get('username')  # 未校验是否为字符串` |
| **长度校验缺失** | 不报告 | `content = request.data.get('content')  # 未限制长度` |
| **格式校验缺失** | 不报告 | `email = request.data.get('email')  # 未校验邮箱格式` |
| **非空校验缺失** | 不报告 | `name = request.data.get('name')  # 未检查是否为 None` |
| **参数校验不足导致 NPE** | 不报告 | `user.getId().toString()  # 未检查 getId() 是否为 null` |
| **类型转换失败** | 不报告 | `int(request.GET['page'])  # 未处理 NumberFormatException` |
| **边界条件检查缺失** | 不报告 | `items = list[page:]  # 未检查 page 是否越界` |

**对比 - 真正的安全漏洞**：
```java
// ❌ 这是 SQL 注入漏洞，必须报告
String sql = "SELECT * FROM users WHERE id = " + request.getParameter("id");
```

### 1.2 日志与调试信息 [FP-1.2]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 日志打印用户信息 | 不报告 | `logger.info("User login: {}", username)` |
| console.log 输出 | 不报告 | `console.log('API response:', data)` |
| 异常堆栈返回前端 | 不报告 | `return jsonify({'error': str(e)})  # 包含堆栈信息` |
| 完整请求日志 | 不报告 | `log.info("Request: {}", request.json)` |
| 调试信息泄露 | 不报告 | `print(f"DEBUG: token={token}")` |

### 1.3 错误处理 [FP-1.3]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 静默返回错误 | 不报告 | `except Exception: pass  # 吞掉异常` |
| 异常信息过于详细 | 不报告 | `raise Exception(f"Failed for user {user_id} at {service}")` |
| 缺少异常处理 | 不报告 | `def process(): data.open()  # 未处理可能的 IOError` |
| 泄露堆栈跟踪 | 不报告 | `return traceback.format_exc()  # 返回完整堆栈` |

### 1.4 代码健壮性 [FP-1.4]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 空指针解引用风险 | 不报告 | `user.getName().toUpperCase()  # getName() 可能为 null` |
| 资源未关闭 | 不报告 | `f = open('file.txt')  # 未使用 with 或 close()` |
| 并发问题 | 不报告 | `count += 1  # 非原子操作，无线程安全保护` |
| 性能问题 | 不报告 | `for item in items: db.query(item)  # N+1 查询` |

---

## 二、合规/业务规范问题（不报告）[FP-2.x]

### 2.1 业务逻辑 [FP-2.1]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 批量操作上限放宽 | 不报告 | `MAX_BATCH_SIZE = 10000  # 从 1000 放宽到 10000` |
| 仅前端验证 | 不报告 | `<!-- 前端验证，后端未重复检查 -->` |
| 优惠券重复使用 | 不报告 | `# 业务逻辑漏洞，需人工处理` |
| 业务权限配置 | 不报告 | `if user.role == 'admin':  # 业务层面的权限判断` |

### 2.2 合规规范 [FP-2.2]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| SNAPSHOT 依赖 | 不报告 | `<version>1.0.0-SNAPSHOT</version>` |
| postMessage 通配符 | 不报告 | `window.postMessage('*', data)` |
| 缺少隐私协议 | 不报告 | `# 首页未显示隐私政策链接` |
| GDPR 合规问题 | 不报告 | `# 未实现用户数据删除接口` |

### 2.3 API 设计 [FP-2.3]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 版本管理混乱 | 不报告 | `/api/v1/user` 和 `/api/v2/user` 同时存在 |
| 缺少限流 | 不报告 | `# API 无速率限制` |
| 缺少分页 | 不报告 | `GET /api/users  # 返回所有用户，无分页` |
| 参数命名不规范 | 不报告 | `def getUserInfo(uId):  # 应为 userId` |
| HTTP 方法未指定 | 不报告 | `@RequestMapping("/api/users")  # 未指定 GET/POST/PUT/DELETE` |

说明：`@RequestMapping` 未指定 HTTP 方法属于 API 设计规范问题（可能接受任意 HTTP 方法），但本身不是安全漏洞。是否限制 HTTP 方法是 API 设计决策，而非安全缺陷。

注：`@RequestMapping` 产生的 GET+OTHER 重复在入库/审计阶段已自动去重，此条仅作为误报判定原则保留。

---

## 三、安全场景误报排除 [FP-3.x]

### 3.1 SSRF 误报排除 [FP-3.1]

> **⚠️ 前置条件**：以下"URL 指向内网/固定域名"的排除规则，**仅在用户输入不影响 URL 的 Host 部分时生效**。
> 若用户输入通过拼接可能改变 Host（如固定前缀不以 `/` 结尾时的 `@` 注入），必须先完成 URL 结构拆解，确认 Host 不可控后再应用排除规则。
>
> **典型误用**：`url = "http://docs.internal" + path`（前缀无 `/`）→ `path = "@evil.com/xxx"` → Host 变为 evil.com → **不适用内网域名排除**。

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| S3 bucket 名称可控 | 不报告 | `s3_client.bucket(user_input).get_object(key='file.txt')  # AK/SK 认证` |
| S3 endpoint 用户可控 | 不报告 | `s3 = S3(endpoint_url=user_input)  # 只是切换 S3 区域` |
| URL 硬编码内部服务 | 不报告 | `url = "http://internal-service/api"` |
| URL 来自 Kconf | 不报告 | `url = kconf.get("api.endpoint")  # 云端配置` |
| URL 来自环境变量 | 不报告 | `url = os.getenv("SERVICE_URL")  # 部署配置` |
| 内网 IP 访问（10.x/172.16-31.x/192.168.x） | 不报告 | `requests.get("http://10.0.0.1/api")  # 正常内网调用` |
| 内网域名访问（\*.internal/\*.local） | 不报告 | `requests.get("http://service.internal/api")  # 服务间通信` |
| localhost/127.0.0.1 访问 | 不报告 | `requests.get("http://localhost:8080/health")  # 本地服务` |
| 硬编码外网 API | 不报告 | `requests.get("https://api.weixin.qq.com/cgi-bin/token")  # 固定第三方服务` |
| **代码硬编码域名白名单** | **不报告** | `ALLOWED = ['api.example.com']; if parsed.netloc in ALLOWED: requests.get(url)  # 攻击者无法控制白名单中域名的 DNS 解析` |
| **第三方服务域名白名单** | **不报告** | `ALLOWED = ['alivod.a.yximgs.com']; if parsed.netloc in ALLOWED: requests.get(url)  # 阿里云等第三方服务域名` |
| **配置中心域名白名单** | **不报告** | `ALLOWED = kconf.get("allowed.domains"); if parsed.netloc in ALLOWED: requests.get(url)  # 云端配置，用户无法修改` |
| **数据库管理员配置的域名白名单** | **不报告** | `ALLOWED = db.query("SELECT domain FROM allowlist"); if parsed.netloc in ALLOWED: requests.get(url)  # 需要管理员权限才能修改，权限提升是独立问题` |
| **Map/Set 查找白名单 + null 回退跳过请求** | **不报告** | `targetUrl = HOST_MAP.get(userHost); if (targetUrl != null) { request(targetUrl); }  // 未匹配的 host 不会发起请求` |

**白名单来源可信度说明**：白名单内容来自以下渠道时，攻击者无法修改白名单本身，无需进行 DNS-IP 二次校验：
- Kconf / Apollo / Nacos 等配置中心
- 数据库配置表（需管理员权限修改）
- 硬编码常量数组（`String[] ALLOWED = {...}`）
| **内部短链服务重定向** | **不报告** | `url = shortUrl; // ksurl.cn 等内部短链，仅内部人员可创建映射，重定向目标受控` |

**对比 - 真正的 SSRF 漏洞**：
```python
# ❌ 这是 SSRF 漏洞，必须报告
url = request.form.get('url')
response = requests.get(url)  # 用户可控的完整 URL

# ❌ 这也是 SSRF 漏洞（@ 注入绕过内网域名）
url = "http://docs.internal" + path  # 前缀无 /，path = "@evil.com/xxx" 可改变 Host
response = requests.get(url)
```

### 3.2 越权误报排除 [FP-3.2]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| S3 同 Bucket 访问 | 不报告 | `s3.get_object(bucket='data', key=user_key)  # 同 bucket 内` |
| S3 key 任意路径 | 不报告 | `key = f"users/{user_id}/profile.jpg"` |
| 公开对象存储跨 Bucket 访问（CDN 公开数据 + 不可枚举 Bucket 名） | 不报告 | `bs3Client.listObjects(bucketName=userInput, prefix=path)  # CDN 公开存储，Bucket 名不可枚举` |
| is_admin / isAdmin 检查存在 | 不报告 | `if user.is_admin:  # 已有管理员权限校验` |
| 白名单校验（枚举/集合） | 不报告 | `if action in ['read', 'write']:  # 白名单限制` |
| RBAC 角色检查（hasRole/checkRole） | 不报告 | `@PreAuthorize("hasRole('ADMIN')")  # 框架权限管理` |
| 资源所有权校验 | 不报告 | `if user.id == resource.user_id:  # 所有权已校验` |
| 数据库查询时过滤（WHERE user_id = ?） | 不报告 | `SELECT * FROM docs WHERE user_id = ?  # ORM 自动过滤` |
| BlobStore key / blobKey 不可枚举 | 不报告 | `bs3Client.getObject(bucket, blobKey)  # blobKey 服务端随机生成，不可遍历` |
| Bucket name (UUID 格式) 不可枚举 | 不报告 | `bs3Client.listObjects(bucketName=userInput)  # UUID 格式不可遍历` |
| AES 加密参数不可枚举 | 不报告 | `AES.decrypt(encryptedParam)  # 密文不可逆推原始值` |
| 同租户/组织内横向访问 | 不报告 | `orgId == currentOrgId 的用户间互相访问  # 租户内共享，设计如此` |

**对比 - 真正的越权漏洞**：
```python
# ❌ 这是越权漏洞，必须报告
user_id = request.args.get('id')
# 未验证当前用户是否有权访问该 user_id
profile = get_profile(user_id)
```

### 3.2.1 自己操作自己资源误报排除 [FP-3.2.1]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 用户查看自己的个人信息 | 不报告 | `GET /api/users/{userId}/profile` + userId == currentUserId |
| 用户修改自己的设置 | 不报告 | `PUT /api/users/{userId}/settings` + userId == currentUserId |
| 用户查询自己的订单列表 | 不报告 | `GET /api/users/{userId}/orders` + userId == currentUserId |
| 用户删除自己的资源 | 不报告 | `DELETE /api/docs/{docId}` + docId.ownerId == currentUserId |

**识别信号**：
- 资源标识符 == 身份标识符（userId/accountId）
- 身份标识符来源为可信（拦截器/注解注入）
- 数据库查询条件包含 `WHERE user_id = ?`（当前用户ID）

**判定流程**：
```
发现IDOR越权访问
    │
    ├─ 判断资源标识符类型
    │   ├─ 身份标识符（userId/accountId/sellerId）
    │   │   └─ 判断身份ID来源
    │   │       ├─ gRPC: request.getUserId() → 可信
    │   │       ├─ Spring MVC: @EspAccount/@Visitor 注入 → 可信
    │   │       ├─ request.getAttribute("userId") → 可信
    │   │       └─ request.getParameter("userId") → 不可信，需继续研判
    │   │
    │   └─ 业务资源标识符（orderId/docId/gameId）
    │       └─ 判断资源归属
    │           ├─ 资源ID == 身份ID → 用户操作自己的资源
    │           └─ 资源ID != 身份ID → 用户操作他人资源
    │
    └─ 判定
        ├─ 用户操作自己的资源 → 安全（不报告）
        └─ 用户操作他人资源 → 继续研判是否越权
```

### 3.2.2 返回布尔值/统计数据误报排除 [FP-3.2.2]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 查询是否收藏（返回boolean） | 不报告或降级为low | `GET /api/content/{id}/isFavorited` → boolean |
| 查询关注状态（返回boolean） | 不报告或降级为low | `GET /api/users/{userId}/isFollowing` → boolean |
| 查询统计数据（返回count） | 不报告或降级为low | `GET /api/content/{id}/viewCount` → int |

**说明**：布尔值和统计数据攻击价值极低，不足以作为真正的安全漏洞。

**判定规则**：
```
接口返回数据类型？
    ├─ 布尔值（boolean/Boolean）
    │   └─ severity 固定为 low（或不报告）
    │
    ├─ 统计数据（int/Integer/long/Long）
    │   └─ severity 固定为 low（或不报告）
    │
    └─ 其他数据类型
        └─ 按正常流程研判
```

### 3.2.3 已公开数据误报排除 [FP-3.2.3]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 查询用户昵称头像（已公开） | 不报告 | `GET /api/users/{userId}/avatar` → 昵称+头像URL |
| 查询商品信息（已公开） | 不报告 | `GET /api/products/{productId}` → 商品详情 |
| 查询公告内容（已公开） | 不报告 | `GET /api/announcements/{id}` → 公告内容 |

**识别信号**：
- 数据已在搜索结果中可见
- 数据无需登录即可访问
- 数据属于公开业务信息（商品、公告、帮助文档）

**判定流程**：
```
确认可越权访问数据
    │
    ├─ 判断数据公开性
    │   ├─ 已在搜索结果中可见 → 不报告
    │   ├─ 无需登录即可访问 → 不报告
    │   ├─ 属于公开业务信息 → 不报告
    │   └─ 非公开数据 → 继续研判
    │
    └─ 判断返回数据类型
        ├─ 仅昵称/头像等低敏感数据 → severity -1
        └─ 完整PII或业务数据 → 维持原等级
```

### 3.2.4 不可枚举 ID 类型误报排除 [FP-3.2.4]

**核心原则**：IDOR 的可利用性依赖于资源标识符的可预测性。不可枚举的 ID 类型（无法通过遍历或预测获取）导致 IDOR 无法实际利用。

| ID 类型 | 可枚举性 | 判定 | 示例代码 |
|---------|---------|------|----------|
| BlobStore key / blobKey | 否 | 不报告或 risk-b | `bs3Client.getObject(bucket, blobKey)  // 服务端随机生成` |
| Bucket name (UUID 格式) | 否 | 不报告 | `bs3Client.listObjects(bucketName, prefix)  // UUID 命名不可遍历` |
| AES 加密参数 | 否 | 不报告或 risk-b | `AES.decrypt(encryptedId)  // 密文不可逆推原始值` |
| Hash ID (>=32位) | 否 | 不报告或 risk-b | `Hashids.encode(id)  // 单向编码不可逆推` |
| 自增 Long/Integer | 是 | 按正常流程研判 | `@GeneratedValue(strategy = IDENTITY)` |
| 雪花 ID | 部分 | 按正常流程研判 | 时间有序但非连续 |

**真实误报案例**：

| ID 类型 | 案例 API | 误报根因 | 正确判定 |
|---------|---------|---------|---------|
| BlobStore key | `GET /rest/kd/music/musician/v2/file/load` | api-audit 报了 IDOR(high)，但 key 是服务端随机生成的 BlobStore 标识，不可遍历 | 不报告 |
| BlobStore key | `GET /rest/kd/music/musician/v2/file/download` | 同上，downloadFile 接口直接用 key 下载 BlobStore 文件 | 不报告 |
| Bucket name + blobKey | `GET /rest/kd/music/download/export/any` | bucket 名和 blobKey 都是不可枚举的，无法构造有效请求 | 不报告 |
| AES 加密参数 | `GET /rest/kd/music/musician/v2/file/redirect` | key 参数经 AES 解密后使用，密文不可逆推原始 BlobStore key | 不报告 |

**判定流程**：
```
确认可越权访问资源
    │
    ├─ 判断资源标识符类型
    │   ├─ BlobStore key / blobKey → 不可枚举 → 单条查询 → risk-b / 不报告
    │   ├─ Bucket name (UUID格式) → 不可枚举 → 不报告
    │   ├─ AES 加密参数 → 不可枚举 → 单条查询 → risk-b / 不报告
    │   ├─ Hash ID (>=32位) → 不可枚举 → 单条查询 → risk-b
    │   ├─ 自增 Long/Integer → 可枚举 → 按正常流程研判
    │   └─ 雪花 ID → 部分可预测 → 按正常流程研判（可降1级）
    │
    └─ 判断查询模式
        ├─ 单条查询 + 不可枚举 ID → risk-b 或不报告
        └─ 批量接口 + 不可枚举 ID → 维持原等级（批量可绕过单条限制）
```

### 3.2.5 同租户横向越权误报排除 [FP-3.2.5]

**核心原则**：多租户系统（组织/公会/团队）内，同租户的用户间横向访问属于业务设计范畴，不构成安全越权。越权审计关注的是跨租户或跨权限边界的访问。

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 同组织内用户互相访问数据 | 不报告 | `org.getMembers()  // 组织内成员共享数据` |
| 同公会内成员查看公会资源 | 不报告 | `guild.getGuildResources(memberId)  // 公会内共享` |
| 同团队内成员访问团队项目 | 不报告 | `team.getProjects(userId)  // 团队内共享` |
| 跨组织/跨公会访问他人数据 | 报告 | `orgService.getOtherOrgData(userId)  // 跨组织访问` |

**真实误报案例**：

| 场景 | 案例 API | 误报根因 | 正确判定 |
|------|---------|---------|---------|
| 同组织内主播互相查看收入 | `POST /rest/live/settlement/income/detail/flow/detail` | api-audit 报了 IDOR(high)，authorId 可越权查看同组织其他主播收入。但这是同公会内主播间的访问，orgId 相同 | 不报告 |
| 同组织内主播收入导出 | `POST /rest/live/settlement/income/detail/flow/author/detail/download` | 同上，同租户内横向访问 | 不报告 |

**识别信号**：
- 查询条件包含 `orgId`/`guildId`/`teamId` 且值为当前用户的租户 ID
- 访问的资源属于同一租户范围
- 接口的业务语义是"查看组织/团队内其他成员的信息"

**判定流程**：
```
确认可越权访问数据
    │
    ├─ 检查是否有多租户上下文
    │   ├─ 有 tenantId/orgId/guildId 等租户标识
    │   │   ├─ 越权目标在同一租户内 → 不报告（租户内共享）
    │   │   └─ 越权目标在不同租户 → 报告（跨租户越权）
    │   └─ 无租户标识 → 按正常越权流程研判
```

### 3.2.6 数据层隐式权限过滤 [FP-3.2.6]

**核心原则**：当 Repository/DAO 层自动注入当前用户身份作为查询条件时，即使 Controller 层没有显式权限校验，数据层已提供隐式保护。

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| MyBatis-Plus LambdaQuery 自动过滤 userId | 不报告 | `lambdaQuery.eq(TodoPO::getAssigneeId, userId)` // userId 来自可信来源 |
| JPA `findByUserId` 风格查询 | 不报告 | `todoRepository.findByUserId(currentUserId)` // 只查自己的数据 |
| QueryDSL 过滤条件包含 userId | 不报告 | `query.where(QTodo.todo.assigneeId.eq(userId))` |
| SQL WHERE 子句含 `user_id = ?`（当前用户） | 不报告 | `SELECT * FROM todos WHERE user_id = ? AND id = ?` |

**识别信号**：
- 查询构建时 `.eq(Entity::getUserId, currentUserId)` 或类似过滤
- `userId`/`accountId` 来自拦截器/注解注入（可信来源）
- ORM 查询方法名含 `ByUserId`/`ByAccountId`

**判定流程**：
```
确认可越权访问数据
    │
    ├─ 检查数据层查询是否自动过滤当前用户身份
    │   ├─ 查询条件包含 WHERE user_id = currentUserId → 不报告（数据层隐式保护）
    │   └─ 查询条件仅用资源ID，无用户ID过滤 → 继续正常流程研判
    │
    └─ 判断 userId 来源是否可信
        ├─ 来自拦截器/注解注入 → 可信，数据层过滤有效
        └─ 来自 request.getParameter → 不可信，数据层过滤可被绕过
```

**真实案例**：
```
# TodoRepositoryImpl 查询中隐式过滤 userId
adopted_comment: "Repository 层隐式过滤 — .eq(TodoPO::getAssigneeId, userId).or().eq(TodoPO::getCreateId, userId)，userId 来自 @Visitor 注入（可信）"

# OrderRepository.findByBuyerIdAndOrderId
adopted_comment: "数据层查询条件含 buyerId = currentUserId，仅返回当前用户订单"
```

### 3.2.7 全局拦截器隐式认证 [FP-3.2.7]

**核心原则**：当项目配置了全局认证拦截器或中间件（如 Spring MVC `WebMvcConfigurer` 注册的 `HandlerInterceptor`，或 NestJS `MiddlewareConsumer` 注册的中间件），即使单个 Controller/Handler 方法没有 `@LoginRequired`/`@UseGuards(AuthGuard)` 等注解，全局拦截器已提供认证保护。

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 全局 `WeakLoginRequiredInterceptor` 拦截所有路径 | 不报告（认证） | `registry.addInterceptor(new WeakLoginRequiredInterceptor()).addPathPatterns("/**")` |
| 全局拦截器 + 排除路径列表 | 部分报告 | 排除列表内的路径无认证 → 报告；其余路径 → 不报告（认证） |
| **路径白名单型拦截器（仅列入的路径需登录）** | 部分报告 | `needLoginPathList=["/aias-employee/*"]` / `addPathPatterns("/admin/**")`：目标 api_path **命中白名单前缀** → 不报告（认证）；**未命中** → 报告认证缺失 |
| `SecurityFilterChain` 配置了认证规则 | 不报告（认证） | `http.authorizeRequests().anyRequest().authenticated()` |
| 注解匹配型拦截器（`preHandle` 内部按注解决定是否拦截） | 仅标注方法受保护 | `preHandle` 中检查 `HandlerMethod` 是否有特定注解（如 `@WeakLoginRequired`），未标注方法直接放行 → 无注解的方法不受保护 |
| NestJS `MiddlewareConsumer` 注册全局中间件 | 不报告（认证） | `consumer.apply(SsoMiddleware).forRoutes("*")` |
| NestJS `MiddlewareConsumer` + `exclude()` 排除路径 | 部分报告 | `exclude()` 列表内的路径无认证 → 报告；其余路径 → 不报告（认证） |
| NestJS `APP_GUARD` 提供者注册全局 Guard | 不报告（认证） | `{ provide: APP_GUARD, useClass: AuthGuard }` 在 `@Module` providers 中 |
| Express/Koa `app.use(authMiddleware)` 全局中间件 | 不报告（认证） | `app.use(ssoMiddleware)` 在 `app.ts`/`main.ts` 中 |
| Egg.js `config.middleware` 注册全局中间件 | 不报告（认证） | `config.middleware = ['auth']` + `app/middleware/auth.js` |

**识别信号**：
- `WebMvcConfigurer` 实现类中注册了认证拦截器
- `SpringSecurity` 配置中定义了全局认证规则
- 拦截器 `preHandle` 方法检查 token/session/cookie
- 拦截器 `preHandle` 方法内部检查方法注解（如 `handler instanceof HandlerMethod && ((HandlerMethod) handler).hasMethodAnnotation(XxxRequired.class)`）→ 注解匹配型，非全局保护
- NestJS `NestModule` 实现类的 `configure()` 方法中通过 `MiddlewareConsumer.apply()` 注册了中间件
- NestJS `@Module` 的 providers 中注册了 `APP_GUARD`
- NestJS `main.ts` 中通过 `useGlobalGuards()` 注册了全局 Guard
- Express/Koa 入口文件中通过 `app.use()` 注册了认证中间件
- Egg.js `config/config.default.js` 中 `config.middleware` 数组包含认证中间件名

**与 arch-scan Step 5 的关系**：arch-scan 应在 Architecture 章节记录全局拦截器信息。**.redtrace/code-audit/PROJECT_CONTEXT.md 仅作参考线索（`[Docs-stated]`，confidence ×0.8），不构成最终判定依据**——即使 .redtrace/code-audit/PROJECT_CONTEXT.md 记录了认证拦截器/路径白名单，api-audit/report-review 仍必须搜索/Read 代码确认拦截器的实际注册方式与路径覆盖范围。

**判定流程**：
```
发现方法无 @LoginRequired / @UseGuards(AuthGuard) 注解
    │
    ├─ 查阅 .redtrace/code-audit/PROJECT_CONTEXT.md Architecture 认证体系章节（仅参考线索，提示去哪里找拦截器配置）
    │
    ├─ 搜索/Read 代码确认全局认证配置（无论 .redtrace/code-audit/PROJECT_CONTEXT.md 是否记录，都必须代码确认）
    │   ├─ 发现拦截器/中间件 → 判断类型
    │   │   ├─ 路径匹配型（addPathPatterns("/**") 或 forRoutes("*") 且无注解过滤）→ 不报告认证缺失
    │   │   ├─ 排除路径型（excludePathPatterns / exclude()）→ 目标路径在排除列表中 → 报告认证缺失；不在排除列表中 → 不报告
    │   │   ├─ 路径白名单型（needLoginPathList / addPathPatterns(具体路径)）→ 目标 api_path 命中白名单前缀 → 不报告认证缺失；未命中 → 报告认证缺失
    │   │   ├─ 注解匹配型（preHandle 内部按注解决定是否拦截）→ 检查目标方法是否有对应注解
    │   │   │   ├─ 方法有对应注解 → 不报告认证缺失
    │   │   │   └─ 方法无对应注解 → 报告认证缺失（拦截器不保护此方法）
    │   │   ├─ SpringSecurity 全局规则 → 不报告认证缺失
    │   │   └─ APP_GUARD / useGlobalGuards → 不报告认证缺失
    │   └─ 无拦截器/中间件 → 报告认证缺失
```

### 3.2.8 页面入口方法 IDOR 误报排除 [FP-3.2.8]

Spring MVC 中常见模式：GET 方法仅返回视图名称（如 `return "createtoken"`），不涉及数据访问。实际业务逻辑在对应 POST 方法中。对此类页面入口方法报告 IDOR 属于误报。

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 方法体仅返回视图名字符串 | 不报告 | `return "createtoken";  // 仅渲染页面` |
| 方法返回 ModelAndView 且无数据查询 | 不报告 | `return new ModelAndView("token/list");  // 仅渲染页面` |
| Thymeleaf/JSP 模板渲染，参数来自服务端转发 | 不报告 | `model.addAttribute("data", service.query(sessionUserId)); return "detail";` |

**识别信号**：
- 方法名含 `page`/`view`/`render`/`show`/`display`/`load` 等页面渲染关键词
- 方法返回类型为模板名（String、ModelAndView）
- 方法体无业务逻辑（仅组装数据返回视图，且数据来源为当前用户身份）
- 参数来源为 `request.getAttribute()`（服务端转发注入），非 `request.getParameter()`（用户输入）

```
发现 IDOR 风险
    │
    ├─ 方法体仅返回视图名字符串（如 return "xxx"）？
    │   ├─ 是 + 无数据访问 → 不报告
    │   └─ 否 → 按正常流程研判
```

### 3.2.9 authToken/一次性凭证 BrokenAccessControl 误报排除 [FP-3.2.9]

当接口通过 token/shareCode/inviteCode 等一次性或限时凭证访问资源时，凭证本身是授权证明（类似 OAuth authorization code），非资源标识符。此类接口不构成 BrokenAccessControl。

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| authToken 一次性凭证验证身份 | 不报告 | `AuthTokenHelper.safeGetCheckAuthTokenResult(authToken)  // 已验证的一次性凭证` |
| shareCode/shareToken 分享链接 | 不报告 | `shareService.getResourceByToken(shareToken)  // 限时分享凭证` |
| inviteCode 邀请码验证 | 不报告 | `inviteService.validate(inviteCode)  // 一次性邀请凭证` |

**识别信号**：
- 参数名为 `authToken`/`shareToken`/`shareCode`/`inviteCode`/`authCode`/`verifyCode`
- 接口通过凭证查询关联资源（非通过资源 ID 直接访问）
- 凭证在数据库中有过期时间/使用次数字段
- 凭证为 UUID 或随机字符串格式（不可枚举）

**注意**：不报告 BrokenAccessControl，但仍需追踪凭证生成点验证安全性（如凭证是否可预测、是否缺少频率限制）。

### 3.2.10 身份冒充 → BrokenAccessControl（非 IDOR）[FP-3.2.10]

当用户可控的 `username`/`accountId` 等身份标识参数，通过 `SsoUserInfo.set`、`UserContext.set` 等机制注入到会话上下文，导致**认证身份本身被用户控制**时，属认证体系绕过，归类为 BrokenAccessControl，**不归类为 IDOR**。

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 用户可控 username 传入 SsoUserInfo.set | BrokenAccessControl | `SsoUserInfo.set(request.getParameter("username"))  // 身份被冒充` |
| 用户可控 accountId 覆盖会话身份 | BrokenAccessControl | `UserContext.setAccountId(inputAccountId);  // 非可信注入` |

**与 IDOR 的区分**：
- IDOR = 有可信认证身份 + 访问他人资源 + 无所有权校验（身份正确，越权访问）
- 身份冒充 = 认证身份本身被用户参数篡改（身份错误，冒充他人）

**识别信号**：身份标识参数来自 `request.getParameter` / request body（非来自拦截器/注解的可信注入），且被写入身份上下文对象。

**注意**：归为 BrokenAccessControl 后，severity 通常高于普通 IDOR（认证体系绕过影响面更大），按 severity-rating.md [表5] 通用快速判定表评定。

### 3.2.11 权限校验被注释/禁用 → BrokenAccessControl（非 IDOR）[FP-3.2.11]

当资源归属校验、审批人校验等权限校验逻辑被代码注释（如 `// checkApprover(...)`）或条件禁用，导致任意用户可操作他人资源时，属 BrokenAccessControl。

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 归属校验代码被注释 | BrokenAccessControl | `// if (order.ownerId != currentUserId) throw new ForbiddenException();  // 校验被注释` |
| 审批人校验被注释 | BrokenAccessControl | `// approverService.validate(userId);  // 校验逻辑禁用` |

**与 report-review.md「注解被注释但 RPC 有效→算防护」的区分**：
- 本规则：权限校验被注释后**无任何替代防护生效** → BrokenAccessControl
- report-review.md：注解被注释但**实际有 RPC 权限校验替代生效** → 视为有效防护，不报告

**识别信号**：代码中存在被注释的校验方法调用、被 `if (false)` 等条件禁用的校验分支，且无其他等价防护。

### 3.3 gRPC 参数溯源误报排除 [FP-3.3]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| userId/sellerId/merchantId/accountId/tenantId/orgId | 不报告 | `String userId = request.getUserId();  # 拦截器从认证提取` |
| SessionContext/UserContext 提取 | 不报告 | `user = SessionContext.getCurrentUser();  # 会话上下文` |
| gRPC 内部服务间调用（非 HTTP 入口） | 不报告 | `internalClient.call();  # 内部调用，无外部入口` |
| request.getAccountId() 等 RPC 方法 | 不报告 | `String accountId = request.getAccountId();  # 上游网关注入，非用户可控` |
| request.getUserId() 等 RPC 方法 | 不报告 | `String userId = request.getUserId();  # 身份凭证由网关注入` |

**说明**：身份凭证类参数（userId、accountId、sellerId 等）虽然从上游传入，但由 gRPC 网关/拦截器从认证信息中提取并注入，用户无法篡改。

### 3.3.1 RPC 下游调用误报排除 [FP-3.3.1]

> **核心原则**：当前服务调用下游 RPC 服务时，**判断危险行为发生在哪一层**。当前层已完成危险行为（如 SQL 拼接）→ 报告漏洞；仅传递原始参数给下游，不确定下游安全措施 → 报告风险-B。

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| **越权：传递了身份凭据给下游** | 不报告 | `downstreamReq.setUserId(userId); downstreamClient.call(downstreamReq); // 下游可做归属校验` |
| **越权：当前层做了资源归属校验** | 不报告 | `if (user.id != resource.ownerId) throw new ForbiddenException(); downstreamClient.call(req);` |
| **越权：仅传资源 ID 给下游，无身份凭据，无归属校验** | 报告漏洞 | `downstreamReq.setResourceId(userInputId); // 未传 userId，未校验归属` |
| **SSRF：用户输入 URL 传给下游 RPC（当前层未发起 HTTP 请求）** | 报告风险-B | `downstreamReq.setUrl(userUrl); // 不确定下游是否走代理/过滤` |
| **SQL注入：当前层做 SQL 拼接后传给下游** | 报告漏洞 | `String sql = "SELECT * FROM t WHERE id=" + userInput; downstreamReq.setQuery(sql); // 拼接在当前层已完成` |
| **SQL注入：仅传原始参数给下游（无拼接）** | 报告风险-B | `downstreamReq.setId(userInput); // 不确定下游是否参数化查询` |
| **其他安全问题：当前层已产生危险行为** | 报告漏洞 | 危险行为在当前层已完成（拼接/构造/序列化等），与下游无关 |
| **其他安全问题：仅传递原始参数给下游** | 报告风险-B | `downstreamReq.setData(userInput); // 不确定下游安全措施` |

**判断流程**：
```
当前服务调用下游 RPC
    │
    ├─ 是越权场景？
    │   ├─ 传了身份凭据给下游 → 不报告（下游可校验）
    │   ├─ 当前层做了归属校验 → 不报告
    │   └─ 两个都没有 → 报告漏洞
    │
    └─ 是其他安全问题？
        ├─ 危险行为在当前层已发生（如 SQL 拼接）→ 报告漏洞
        └─ 仅传原始参数，不确定下游安全措施 → 报告风险-B
```

**边界**：仅适用于「当前服务调用下游 RPC 服务」的场景。如果当前服务自身就是 sink 点（如当前服务直接发 HTTP 请求），则按原有规则判定。

### 3.3.2 SQL 注入类型转换误报排除 [FP-3.3.2]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 参数经过日期解析函数 | 不报告 | `DateUtils.parseDate(input)` → 仅合法日期通过 |
| 参数经过数值解析函数 | 不报告 | `Integer.parseInt(input)` → 仅合法数字通过 |
| 参数经过 UUID 解析函数 | 不报告 | `UUID.fromString(input)` → 仅合法 UUID 通过 |
| 参数经过枚举转换 | 不报告 | `EnumType.valueOf(input)` → 仅合法枚举值通过 |
| 解析后重新格式化再拼接 | 不报告 | `parseDate(input) → formatTimeStamp()` → 输出格式固定 |
| getOrDefault 回退值为固定安全字符串 | 不报告 | `SORT_MAP.getOrDefault(userInput, "create_time")  // "create_time" 是固定值，非用户输入` |

**前提条件**（适用于前 5 行「解析函数」类场景）：
1. 解析函数必须会抛异常（非静默返回 null/默认值）
2. 解析后的值直接或经格式化后拼接到 SQL，中间无其他用户可控输入混入

**前提条件**（适用于「getOrDefault 回退值」场景）：
1. getOrDefault 的回退值必须是固定安全字符串（非用户输入、非变量）

**getOrDefault 误报案例**：
- 案例 API: `POST /rest/live/settlement/monthSettlement/record/freeze/count`
- 代码: `SORT_KEY_MAP.getOrDefault(request.getSortKey(), "create_time")`
- 误判: api-audit 将 fallback 描述为"用户输入值拼接 SQL"
- 实际: 用户输入 `"IF(1=1,SLEEP(5),0)"` → Map 查找失败 → 返回固定默认值 `"create_time"` → 注入 payload 被替换为安全值 → 白名单正确生效

**对比 - 真正的 SQL 注入**：
```java
// ❌ 这是 SQL 注入漏洞，必须报告
String keyword = request.getKeyword();
requestParamMap.put("keyword", keyword);  // 无解析/转换，直接拼接
```

### 3.3.3 Spring MVC 自定义注解参数注入误报排除 [FP-3.3.3]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 自定义注解 + HandlerMethodArgumentResolver 注入的身份 ID | 不报告 | `public Response method(@EspAccount Long accountId)` |
| @Visitor/@LoginUser/@CurrentAccount 等注解注入 | 不报告 | `public Response method(@Visitor VisitorInfo visitor)` |
| 从 HttpServletRequest.getAttribute() 获取的身份 ID（拦截器注入） | 不报告 | `Long userId = (Long) request.getAttribute("userId")` |

**识别模式**：
1. Controller 方法参数前有自定义注解（非 @PathVariable/@RequestParam/@RequestBody）
2. 该注解通过 HandlerMethodArgumentResolver 实现类解析
3. 解析逻辑从 HttpServletRequest 的 attribute/session 中获取身份凭证
4. 身份凭证由上游拦截器/过滤器从认证 token 中提取并注入

**说明**：Spring MVC 中通过自定义注解注入的身份凭证，本质上与 gRPC 拦截器注入的 userId 等价——均由框架/中间件从认证信息中提取，用户无法篡改。常见注解包括但不限于 @EspAccount、@Visitor、@LoginUser、@CurrentAccount、@AuthUser 等。

**判定流程**：
```
发现 Controller 方法参数有自定义注解
    │
    ├─ 注解是否为 @PathVariable/@RequestParam/@RequestBody？
    │   ├─ 是 → 按正常流程研判（用户可控）
    │   └─ 否 → 继续
    │
    ├─ 参数是否为身份 ID 类型（userId/accountId/sellerId 等）？
    │   ├─ 是 → 搜索对应 HandlerMethodArgumentResolver 实现
    │   │        ├─ 从 request.getAttribute/session 获取 → 不报告（可信来源）
    │   │        └─ 从 request.getParameter 获取 → 按正常流程研判
    │   └─ 否 → 按正常流程研判
```

**检测命令**：
```bash
# 查找 HandlerMethodArgumentResolver 实现
grep -rn "HandlerMethodArgumentResolver\|resolveArgument" --include="*.java"

# 查找自定义参数注解
grep -rn "@EspAccount\|@Visitor\|@LoginUser\|@CurrentAccount\|@AuthUser" --include="*.java"
```

### 3.3.4 ES 字段名排序 vs NoSQL 注入 [FP-3.3.4]

Elasticsearch 的 `addSort(field, order)` 仅控制排序字段名与排序方向，无法注入查询逻辑（不像 SQL 拼接可改变 WHERE/查询结构）。字段名无白名单时属 FP-1.1 输入验证缺失（代码质量），非 NoSQL 注入。

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| ES addSort 字段名无白名单 | 不报告 NoSQLi（可记 FP-1.1） | `searchSourceBuilder.addSort(request.getSortField(), SortOrder.ASC)  // 仅控制排序字段名` |
| ES QueryBuilder 拼接用户输入到 query | 报告漏洞 | `boolQuery.must(QueryBuilders.queryStringQuery(userInput))  // 可注入查询逻辑` |

**区分要点**：判断用户输入是否参与**查询逻辑构建**（WHERE/查询结构，如 QueryBuilder/stringQuery）——若仅控制排序字段名/分页大小等元信息，非注入。

### 3.3.5 外部依赖拦截器无法读源码 → risk-b [FP-3.3.5]

当安全拦截器/Filter 的实现位于外部 JAR 或不可访问模块，无法 Read 源码确认防护逻辑时，保守判定为 risk-b（入口可达 + 防护不明确），不判定为 risk-a。

| 场景 | 判定 | 说明 |
|------|------|------|
| 拦截器实现在外部依赖，无法确认防护逻辑 | risk-b | 入口可达 + 防护不明确，符合"不做假设"原则 |
| 拦截器实现可读且确认有防护 | 按 FP-3.2.7 判定 | 全局拦截器隐式认证 |

**注意**：risk-a 仅适用"无 HTTP/gRPC 入口可达"场景。只要接口有路由定义且可外部调用，即使防护不明确，也应归 risk-b 而非 risk-a。

### 3.4 配置数据源误报排除 [FP-3.4]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| Kconf 配置值 | 不报告 | `url = kconf.get("api.endpoint");  # 云端配置` |
| Apollo/Nacos 配置值 | 不报告 | `value = apollo.getConfig("key");  # 配置中心` |
| 环境变量（System.getenv/os.getenv） | 不报告 | `url = os.getenv("SERVICE_URL");  # 服务端配置` |
| 数据库配置表 | 不报告 | `config = db.query_config();  # 系统内部数据` |
| Consul/etcd 配置 | 不报告 | `value = consul.get("key");  # 分布式配置` |
| **间接引用 antiSsrfProxiesList** | **不报告** | `proxy = SquidProxyUtils.getProxy("china");  # 溯源后确认为隔离代理配置` |

**配置溯源规则**：当变量名不含 anti/ssrf 时，需追踪到最终配置来源。如果配置来源为 `public.httpProxy.antiSsrfProxiesList`，则判定为隔离代理防护。

### 3.5 硬编码凭证 [FP-3.5]

| 场景 | 判定 | 示例位置 |
|------|------|----------|
| 测试代码凭证 | 不报告 | `tests/test_config.py: API_KEY = "test_key_123"` |
| 配置文件凭证 | 不报告 | `.env: DB_PASSWORD=dev_password` |
| 示例代码凭证 | 不报告 | `# README.md 示例中的 AKIAIOSFODNN7EXAMPLE` |
| 生产代码凭证 | 报告风险-A | `API_KEY = "AKIA..."  # 在 src/ 生产代码中` |

### 3.6 隐私视频误报排除 [FP-3.6]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| SDK调用结果仅用于后端判断（计数/审核/校验逻辑）| 不报告 | `photo.getPhotoStatus() == PUBLIC` 用于条件判断 |
| photoId 来自数据库查询而非用户请求参数 | 不报告 | `Long photoId = order.getPhotoId()` |
| 已调用 PhotoRequestOption.defaultRequestOption() | 不报告 | 只查公开视频 |
| 已设置 setEnableFeedFilter(true) | 不报告 | 过滤非公开视频 |
| gRPC request.getUserId() 等网关注入身份ID | 不报告 | 非用户可控 |
| 接口限制在非线上环境（STAGING/TESTING/LOCAL） | 不报告 | 非线上环境 |

---

### 3.7 拦截型校验后使用原始变量 [FP-3.7]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| 校验函数失败即 return/raise，sink 使用原始变量 | 不报告 | `is_safe = validate(path); if not is_safe: return; open(path)` |
| 校验函数失败即 return/raise，sink 使用校验后变量 | 不报告 | `safe_path = validate(path); if not safe_path: return; open(safe_path)` |
| 校验函数仅设置标志位，不中断执行流 | 按正常流程研判 | `is_safe = validate(path); open(path)  // 未检查 is_safe 或检查后未中断` |

**核心原则**：拦截型校验函数（校验失败即 return/raise/exit）位于 source→sink 路径中间时，只有通过校验的数据才能到达 sink，此时 sink 使用原始变量还是校验后变量不影响安全性。

**判定流程**：
```
发现 sink 使用未经验证返回值的原始变量
    │
    ├─ 检查 sink 之前是否有拦截型校验
    │   ├─ 有拦截型校验（return/raise/exit on failure）→ 不报告
    │   ├─ 无拦截型校验 → 按正常流程研判
    │   └─ 有校验但非拦截型（仅设标志位）→ 按正常流程研判
```

---

### 3.8 查询型校验导致的控制流中断 [FP-3.8]

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| Map 查询 + null 检查 | 不报告 | `task = store.get(taskId); if (task == null) return; loadFromDisk(taskId);` |
| 数据库查询 + 空结果检查 | 不报告 | `user = db.query(userId); if (user == null) throw; process(user.data);` |
| 缓存查询 + 缺失检查 | 不报告 | `val = cache.get(key); if (val == null) return; useVal(val);` |
| 查询键为系统生成（UUID） | 不报告 | `taskId = UUID.randomUUID(); store.get(taskId);` |

**核心原则**：当用户输入仅作为查询键，且查询失败会阻断控制流时，攻击者无法使污染数据到达 sink，判定为安全。

**判定流程**：
```
发现 source 变量仅用于查询操作（如 store.get(source)）
    │
    ├─ 检查查询键格式是否可预测
    │   ├─ UUID/随机字符串 → 不可预测 → safe
    │   ├─ 数据库自增 ID → 可预测 → 继续分析
    │   └─ 用户输入字符串 → 可预测 → 继续分析
    │
    ├─ 检查查询失败时的控制流
    │   ├─ 有显式 return/throw → 控制流中断 → safe
    │   └─ 无显式中断，但后续代码依赖查询结果（如 obj.method()）
    │       ├─ obj 可能为 null → NPE 风险（非安全问题，不报告）
    │       └─ obj 一定不为 null → 继续分析 sink 可达性
    │
    └─ 综合判定
        ├─ 查询键不可预测 或 控制流中断 → safe
        └─ 查询键可预测 且 控制流未中断 → 按正常流程研判
```

**真实误报案例**：

| 案例 | 告警类型 | 误判根因 | 正确判定 |
|------|---------|---------|---------|
| realtime-data-compare | Absolute_Path_Traversal | Agent 认为 taskId 可控到达 loadFromDisk，但忽略了 taskStore.get(taskId) 的拦截作用 | safe（taskId 不存在时直接 return） |

### 3.9 分支互斥 + 业务层输入限制 [FP-3.9]

**适用场景**：代码存在多个协议/输入类型分支，安全分支有早期 return，危险分支需要特定输入才能触发。

**判定条件**（同时满足时不报告）：

| 条件 | 说明 |
|------|------|
| 安全分支存在早期 return | 如 `data:` 协议分支处理后直接 return，不执行后续网络请求 |
| 危险分支需要特定输入触发 | 如 `http/https` 分支仅在非 `data:` 输入时才执行 |
| 历史记录或业务文档明确说明输入限制 | 如备注"只允许data协议"、"未发送网络请求" |

**历史备注辅助判断规则**：历史备注是辅助证据而非独立判定依据，三个判定条件必须同时满足才能判定 safe。备注用于辅助解读危险分支在业务上是否可达：

| 备注关键字 | 辅助含义 |
|----------|---------|
| "只允许XX协议" | 辅助说明业务层输入限制，危险分支业务上不可达 |
| "未发送网络请求" | 辅助说明控制流分析结论，sink 实际不可达 |
| "无HTTP入口" | 辅助说明入口可达性结论 |

当备注与代码表面逻辑矛盾时，备注不能单独推翻代码分析结论；必须先在代码中找到佐证（如安全分支有早期 return、危险分支确实需要特定输入），再结合备注辅助确认危险分支在业务上不可触发，方可判定 safe。

---

### 3.10 文件上传无持久化（仅内存解析）[FP-3.10]

**核心原则**：文件上传漏洞的危害前提是"文件被持久化到可访问的存储"。若上传内容仅用于内存解析（EasyExcel/POI/JSON/图片解码/csv 等），且全程无落盘 sink（`transferTo`/`Files.write`/`file.save`/对象存储写入等），则不构成文件上传漏洞。

| 场景 | 判定 | 示例代码 |
|------|------|----------|
| MultipartFile 仅 EasyExcel.read 内存解析 | 不报告（文件上传） | `EasyExcel.read(file.getInputStream(), DemoData.class, listener).sheet().doRead();  // 无 transferTo` |
| FileStorage 仅 pandas/read_csv(file.stream) | 不报告（文件上传） | `df = pandas.read_csv(file.stream)  // 仅读入内存，无 file.save` |
| req.file.buffer 仅 JSON.parse 解析 | 不报告（文件上传） | `const data = JSON.parse(req.file.buffer.toString());  // 无 fs.writeFile` |

**⚠️ 边界（排除仅限"文件上传"类别，仍需转查其他类别）**：内存解析仍可能触发——Excel/POI/EasyExcel 的 XXE（旧版本）与 zip-bomb DoS、解析序列化对象的反序列化、大文件/深层 XML 的 OOM 与 billion-laughs、图片解码库（ImageMagick/sharp）漏洞。

**判定流程**：
```
发现 FileUpload 风险
    │
    ├─ 调用链中是否存在持久化 sink（transferTo/Files.write/file.save/对象存储写入）？
    │   ├─ 否（仅内存解析，如 EasyExcel.read/JSON.parse/ImageIO.read/pandas.read_csv）→ 不报告文件上传漏洞 [FP-3.10]，转查 XXE/反序列化/DoS
    │   └─ 是 → 按文件上传规则正常研判
```

---

## 四、判定流程 [FP-4.x]

```
发现潜在问题
    │
    ├─ 是否为代码质量问题？
    │   ├─ 类型/长度/格式校验缺失 → 不报告
    │   ├─ 日志/调试信息泄露 → 不报告
    │   ├─ 错误处理不当 → 不报告
    │   └─ 代码健壮性问题 → 不报告
    │
    ├─ 是否为合规/业务规范问题？
    │   ├─ 业务逻辑问题 → 不报告
    │   ├─ 合规规范违规 → 不报告
    │   └─ API 设计问题 → 不报告
    │
    └─ 是否存在真正的安全风险？
        └─ 按对应漏洞类型判定流程执行
```
