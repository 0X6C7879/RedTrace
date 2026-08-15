# 可信数据源判定规则

## 核心原则

某些数据源用户无法篡改，默认判定为安全可信，无需进一步防护验证。

---

## 1. 数据库查询结果

**从数据库查询得到的值，用户无法篡改，默认判定为安全可信。**

- 数据库中的配置/URL由管理员维护，用户不可控
- 不要默认推断"可能存在SQL注入导致数据被篡改"

```java
// 安全：数据库查询URL（用户不可篡改）
String url = urlDao.getByType("callback");  // URL来自数据库，用户无法修改
httpClient.execute(url);
```

---

## 2. Kconf 配置系统

**Kconf 是公司云配置系统，配置内容存放在云端，默认安全且用户不可控。**

### 核心原则

1. **研发自配置**：Kconf 配置由研发人员在云端配置平台维护
2. **用户无法篡改**：普通用户无法修改 Kconf 配置值
3. **默认安全可信**：Kconf 获取的数据为可信数据源
4. **无需验证具体值**：不需要读取云端配置的实际值进行验证

### 代码模式识别

| 模式 | 说明 |
|------|------|
| `kconf.getString("key")` | 获取云端配置值，可信数据源 |
| `KconfConstant.ALLOWED_XXX` | 白名单常量来自云端配置 |
| `KconfUtils.getBoolean("key")` | 布尔配置值，可信 |
| `@Kconfig("foo.bar.baz")` | Spring 依赖注入方式 |

### 禁止的误判

**错误判定**：
> 白名单依赖 KconfConstant.ALLOW_DYNAMIC_SPLICE_COLUMNS 配置，配置可能为空 → 缺少信息无法判断

**正确判定**：
> 白名单依赖 Kconf 配置，Kconf 为研发自配置且用户无法篡改的可信数据源 → 安全（参数不可控）

```java
// 安全：Kconf配置（云端可信）
String host = kconf.getString("db.host");  // 可信数据源
String baseUrl = kconf.getString("api.base.url");

// 安全：白名单来自Kconf配置
if (KconfConstant.ALLOW_DYNAMIC_SPLICE_COLUMNS.contains(column)) {
    // Kconf配置为研发自配置且用户无法篡改，默认可信
}
```

---

## 3. 会话上下文

`userId`、`merchantId`、`accountId` 等从用户会话上下文获取：

- 通常为数字类型、服务端提取、用户不可篡改
- 默认判定为安全

```java
// 安全：会话上下文提取
long userId = SessionContext.getUserId();  // 服务端提取，用户不可篡改
String merchantId = UserContext.getMerchantId();
```

### gRPC 场景下的会话上下文

gRPC 场景下，身份凭据由**上游网关注入**。

#### 身份凭据字段（不可控）

| 字段名 | 说明 |
|--------|------|
| `userId` | 用户 ID |
| `sellerId` | 商家 ID |
| `merchantId` | 商户 ID |
| `accountId` | 账户 ID |
| `sessionId` | 会话 ID |
| `token` / `authToken` | 认证令牌 |

#### 判定规则

**字段名为上述身份凭据名称** → 直接判定为不可控（安全）

**其他业务字段** → 用户可控，需继续研判

---

## 4. BlobStore 对象存储

**BlobStore 是公司自研的对象存储服务，用于安全存储非结构化数据。**

### 核心原则

1. **统一存储**：作为公司统一的对象存储入口，有完善的安全措施
2. **环境隔离**：PROD/CANDIDATE/STAGING 环境之间互相独立
3. **Region 隔离**：不同地域的数据存储隔离
4. **强一致性**：同环境下上传后立即可读

### 代码模式识别

| 模式 | 说明 |
|------|------|
| `BS3Client` / `BS3ClientConfig` | 新版 SDK 客户端 |
| `BlobStoreClient` / `BlobStoreTable` | 旧版 SDK |
| `bs3.putObject()` | 上传对象到 BlobStore |
| `bs3.getObject()` | 下载对象 |
| `blobstore.upload()` | 旧版上传方法 |

### 禁止的误判

**错误判定**：
> 代码使用 BlobStore 存储，但未确认 Bucket ACL 设置 → 无法判断安全性

**正确判定**：
> BlobStore 是公司统一对象存储服务，使用 BlobStore 存储文件默认为安全防护措施 → 安全（统一存储）

```java
// 安全：新版 SDK 上传
BS3Client bs3 = BS3Client.create(config);
bs3.putObject("bucketName", "key", body, metadata);

// 安全：从 Kconf 获取 AK/SK
String ak = kconf.getString("blobstore.ak");
String sk = kconf.getString("blobstore.sk");
```

---

## 5. 环境判断

**仅关注线上环境（prod/preonline）的代码逻辑**

| 环境                     | 判定        |
|------------------------|-----------|
| prod/preonline         | 关注，正常研判   |
| test/staging/dev/local | 不关注，判安全 |

### 识别信号

- 配置项：`env.equals("prod")`、`isProd()`、`isPreonline()`
- 条件分支：`if (ENV == "production")`、`if (!isTest())`
- 配置文件：`application-prod.yml`、`bootstrap-online.properties`

```java
// 无效：测试环境执行
if (Env.isLocal() || Env.isDev()) {
    httpClient.execute(url);  // 非线上环境，不关注
}

// 需研判：线上环境执行
if (Env.isProd()) {
    httpClient.execute(url);  // 需正常研判
}
```

---

## 6. 跨接口数据流（间接污染源识别）

**核心问题**：sink 所在接口的 source 看似为"用户输入"（Model/DTO/JSON 字段），但其值实际由其他接口写入 DB 后再读取。判定时必须追溯**实际写入路径**，而非仅看 sink 接口的代码层入参。

### 典型场景

```
接口 A (Create): 用户提交 deployKey → 写入 DB
接口 B (Deploy): 从 DB 读取 deployKey → 拼接路径 → bs3.putObject(path)

CodeQL 在 B 接口标记 deployKey 为 source，
但 deployKey 的实际可控性由 A 接口决定。
```

### 判定规则

| 写入侧（接口 A） | 读取侧（接口 B） | 最终判定 |
|------------------|------------------|----------|
| A 对字段有白名单/格式校验 | B 直接使用 | **safe**（写入侧已限制） |
| A 无校验，但 A 不对外暴露（仅内部调用） | B 直接使用 | **safe** 或 **risk-a**（攻击面受限） |
| A 无校验且对外暴露 | B 直接使用 | 视 B 侧防护决定（可能 vulnerability） |
| 字段为系统生成（UUID/雪花 ID） | B 直接使用 | **safe**（不可预测） |
| 字段值仅由内部服务写入 | B 直接使用 | **safe**（trusted-sources §3 类比） |

### 检索方法

```bash
# 1. 找字段所有写入点
grep -rn "\.set{FieldName}\|\.{fieldName}(" --include="*.java"

# 2. 找字段所有 builder/构造
grep -rn "\.{fieldName}(" --include="*.java"

# 3. 找包含该字段的 DAO 方法
grep -rn "{FieldName}\|{fieldName}" --include="*Dao.java" --include="*Mapper.java" --include="*Repository.java"
```

### 禁止的误判

| 错误判定 | 正确判定 |
|----------|----------|
| Model 字段名暗示用户输入 → 默认可控 | 必须追溯字段实际写入路径 |
| sink 接口未发现校验 → 判定漏洞 | 检查写入侧接口是否已有校验 |
| 字段从 DB 读取后仍视为外部输入 | DB 数据由写入接口的校验决定可控性 |
| JSON 字段必然来自用户 | 可能来自后端服务装配（DB 查询、RPC 拼装） |

### 与 §1（DB 查询）的关系

§1 定义"DB 查询结果默认可信"，本节进一步明确：
- 当 DB 字段最初由**对外接口**写入时，其可信度等同于"该写入接口的校验强度"
- 当 DB 字段由**内部服务/管理员**写入时，等同 §1 的默认可信
- 判定时必须回答："这个字段最初是怎么进入 DB 的？"

---

---

## 7. 常见系统补全字段

**核心问题**：字段在代码层声明于 DTO/Model 中，但实际运行时的值由系统服务端补全，用户不在请求中传入。混淆"代码层声明"与"运行时实际来源"是 SSRF/文件操作类漏洞 FP 的高发根因。

### 字段名模式列表

当 source 为 Map/List/DTO 字段且字段名匹配以下模式时，自动触发"系统补全字段"判定流程：

| 字段名模式 | 典型补全服务 | 说明 |
|------------|-------------|------|
| `cover_url` / `coverUrl` / `coverUrlMap` | VideoApiClient / PhotoInfoFacade / 视频服务 | 封面 URL，业务流程中由视频服务批量补全 |
| `video_url` / `videoUrl` / `videoUrlMap` | VOD 服务 / 点播平台 | 视频播放 URL，由 VOD 服务端填充 |
| `audio_url` / `audioUrl` / `audio_url_map` | ASR 服务 / 音频处理服务 | 音频文件 URL，由 ASR 服务端填充 |
| `thumbnail_url` / `thumbUrl` | CDN / 图片处理服务 | 缩略图 URL，由图片处理服务填充 |
| `resource_url` / `resourceUrl` / `res_url` | 资源管理系统 | 资源 URL，由资源管理服务装配 |
| `file_url` / `fileUrl` / `file_url_list` | 文件服务 / BlobStore | 文件 URL，由文件上传服务生成 |
| `attachment_url` / `attachUrl` | 附件服务 | 附件 URL，由附件管理服务填充 |
| `image_url` / `imageUrl` / `img_url` | 图片服务 / CDN | 图片 URL，由图片服务处理 |
| `avatar_url` / `avatarUrl` | 用户服务 | 头像 URL，由用户服务补全 |
| `redirect_url` / `redirectUrl` | 网关 / 短链服务 | 跳转 URL，由网关或短链服务填充 |
| `icon_url` / `iconUrl` | 图标服务 | 图标 URL，由图标管理服务提供 |
| `callback_url` / `callBackUrl` | 配置中心 / DB | 回调 URL，通常来自 DB 配置或系统常量 |
| `download_url` / `downloadUrl` | 文件服务 | 下载 URL，由文件服务生成 |
| 以 `_url` / `Url` / `_uri` / `Uri` 结尾的字段 | 对应业务服务 | 通用 URL 类字段，需追溯实际赋值来源 |

### 判定规则

| 场景 | 判定 | 说明 |
|------|------|------|
| 字段名匹配上述列表 → 找到对应系统补全服务 | ✅ 系统补全字段 | 运行时用户不传入，直接 safe |
| 字段名匹配上述列表 → 字段仅在响应 DTO 中出现 | ✅ 系统补全字段 | 非请求入参，用户无法传入 |
| 字段名匹配上述列表 → 字段由 DB 查询填充 | ✅ 系统补全字段 | 数据源可信，判 safe |
| 字段名匹配上述列表 → 未找到系统补全证据 | ❌ 非系统补全字段 | 需继续追溯用户输入路径 |
| 字段名不匹配 → 默认不触发此流程 | — | 按正常数据流分析 |

### 与 §6（跨接口数据流）的关系

§6 关注的是"跨接口的写入-读取链路"，本节补充的是"同一业务流程内的系统补全机制"：
- §6 场景：接口 A 写入 DB → 接口 B 从 DB 读取（如 deployKey）
- §7 场景：接口 A 接收请求 → 后端服务自动补全字段 → 传递给 sink（如 coverUrlMap）
- 两者共同点：**代码层声明 ≠ 运行时实际来源**，判定时必须回答"运行时值从哪里来"而非"代码层能否传入"

### 检索方法

```bash
# 1. 按字段名搜索所有引用
grep -rn "cover_url\\|coverUrl\\|videoUrl" --include="*.java"

# 2. 搜索字段写入点（service/补全逻辑）
grep -rn "setCoverUrl\\|put(\"cover_url\\|put(coverUrl" --include="*.java"

# 3. 搜索对应补全服务
grep -rn "VideoApiClient\\|PhotoInfoFacade\\|VodService\\|AsrService" --include="*.java"

# 4. 确认字段是否仅在响应 DTO 中
grep -rn "字段名" --include="*Req*.java" --include="*Resp*.java"
```

---

## 研判检索方法

| 检索项 | 检索方法 |
|--------|----------|
| Kconf 配置 | Grep: `kconf.getString` / `KconfConstant` / `@Kconfig` |
| 数据库查询 | Grep: `Dao.getByType` / `Repository.find` |
| 会话上下文 | Grep: `SessionContext.get` / `UserContext.get` |
| BlobStore | Grep: `BS3Client` / `BlobStoreClient` / `bs3.putObject` |
| 环境判断 | Grep: `Env.isProd` / `isPreonline` / `isLocal` |
| 系统补全字段 | Grep: `cover_url` / `videoUrl` / `VideoApiClient` / `VOD` / `ASR` |

---

## 禁止的误判汇总

| 错误判定 | 正确判定 |
|----------|----------|
| 白名单依赖 Kconf 配置，配置可能为空 → 无法判断 | Kconf 为研发自配置且用户无法篡改 → 安全 |
| BlobStore 存储，未确认 ACL → 无法判断 | BlobStore 统一存储有安全措施 → 安全 |
| 可能存在 SQL 注入导致数据被篡改 → 需研判 | 数据库数据由管理员维护，用户不可篡改 → 安全 |
| userId 参数名像用户输入 → 需研判 | userId 由网关注入，用户不可篡改 → 安全 |
