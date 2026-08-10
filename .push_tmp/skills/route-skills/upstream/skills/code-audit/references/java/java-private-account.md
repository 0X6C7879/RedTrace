# 私密账号越权

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> SDK 返回值不返回前端 = 无私密账号越权（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：确认 SDK 返回值是否到达前端
2. **然后**：确认 userId/photoId 是否攻击者可控
3. **仅当** 返回值到达前端且参数可控时，才检查校验逻辑
4. **调用链不完整**（关键方法缺失、`...`/`TODO` 占位符、依赖未提供的拦截器）→ unknown
5. **禁止**：一上来就检查"有没有校验"

**三维度独立判定**：
- 维度1：是否存在可直接获取用户隐私视频的漏洞
- 维度2：是否存在可直接获取私密账号视频的漏洞
- 维度3：是否存在绕过《不让 ta 看》获取主页视频的漏洞

---

## 1. 结论判断标准

**攻击者视角假设**（强制执行）：

| 假设项 | 说明 |
|--------|------|
| 攻击者身份 | 外部用户，普通用户权限 |
| 可控参数 | 接口入参中的 userId、photoId（经简单数据处理后仍视为可控） |
| 不可控参数 | 来自 DB 查询、后端服务查询的 userId/photoId |

**通用结论**：

| 结论 | 定义 | 判定条件 |
|------|------|---------|
| **漏洞** | 任一维度为"是"且有 HTTP/gRPC 入口 | 存在危险 SDK 调用 + 参数可控 + 无有效防护 + 视频返回前端 + 有入口 |
| **风险-A** | 无 HTTP/gRPC 入口可达 | SDK 调用 + 无外部入口 |
| **风险-B** | 有入口但校验不充分 | 有部分校验（如仅检查作者未检查公开状态） |
| **安全** | 无危险写法或有充分校验 | 返回值仅后端使用 / 完整校验 / 参数不可控 |
| **unknown** | 调用链不完整 | 关键方法/类未给出 / `...`/`TODO` 占位符 / 依赖未提供的拦截器/切面/网关 |

---

## 2. 研判思路

### Step 0: SDK 返回值用途检查 【黄金法则门禁】

**触发条件**: 开始审计任何视频 SDK 调用代码

**必做动作**:
1. 确认 SDK 返回的视频信息是否被写入 Controller/接口方法的返回值
2. 检查以下"返回前端"的方式：
   - 方法的 `return xxx;`
   - 设置到返回对象字段（`result.setPhotos(photos)`、`vo.setPhotoList(photos)`）
   - 放入返回 Map/Model（`map.put("photos", photos)` 且该 map 作为返回值）
   - 通过 `response.getWriter().write(...)` 等直接写入响应体

**结束门槛**:
- 视频信息仅用于后端判断（条件/计数/审核/埋点/统计）→ 安全（直接终止）
- 视频信息仅写入日志/存储/缓存/队列（与前端无关）→ 安全（直接终止）
- 视频信息写入返回值 → 继续 Step 1

**禁止**:
- 假设 SDK 调用就一定返回前端

---

### Step 1: 调用链完整性检查 【终止点】

**触发条件**: Step 0 确认返回值到达前端

**必做动作**:
1. 检查代码是否有缺失信息
2. 识别以下不完整信号：`...`/`TODO` 占位符、关键方法/类未给出、依赖未提供的拦截器/切面/网关

**结束门槛**:
- 调用链不完整 → unknown（终止，输出 JSON）
- 调用链完整 → 继续 Step 2

**禁止**:
- 假设未给出的拦截器/切面会提供防护

---

### Step 2: 参数来源检查 【终止点】

**触发条件**: Step 1 确认调用链完整

**必做动作**:
1. 追踪 userId/photoId 的来源
2. 区分"可控"与"不可控"

**可控性判定表**:

| 来源 | 可控性 | 判定 |
|------|--------|------|
| @PathVariable/@RequestParam/@RequestBody | 可控 | 继续 Step 3 |
| 简单数据处理（去重/过滤null/类型转换/封装集合）后传入 SDK | 仍视为可控 | 继续 Step 3 |
| DB 查询结果（如 tagId → 查 DB 得 photoId） | 不可控 | 安全（终止） |
| 后端服务查询结果 | 不可控 | 安全（终止） |
| gRPC 网关注入（request.getUserId()） | 不可控 | 安全（终止） |
| 内部计算/配置/常量 | 不可控 | 安全（终止） |

**结束门槛**:
- 参数不可控 → 安全（直接终止）
- 参数可控 → 继续 Step 3

**禁止**:
- 假设参数名含 id 就用户可控

---

### Step 3: SDK 方法分类 + 攻击路径识别

**触发条件**: Step 2 确认参数可控

**必做动作**:
1. 识别代码中使用的 SDK 及其方法
2. 将攻击路径分为两类

**攻击路径分类**:

| 路径 | SDK | 关键参数 | 进入步骤 |
|------|-----|---------|---------|
| userId-based | PhotoAuthorService / PhotoAuthorServiceRpcClient | userId（第一个参数） | Step 4a |
| photoId-based | PhotoService / PhotoServiceRpcClient | photoId | Step 4b |
| photoId-based | PhotoUrlService / PhotoUrlServiceRpcClient | photoId | Step 4b |
| photoId-based | FeedViewService / FeedViewServiceRpcClient | `.requests[*].photoRequest.photoId` | Step 4b |

**SDK 方法详细分类**:

**PhotoAuthorService（userId-based）**:

| 方法 | 参数 | 返回内容 | 视频范围 |
|------|------|---------|---------|
| `getPhotoTimeByAuthor` | userId | 所有视频时间信息 | 全部（含私密账号） |
| `getAuthorAllPhotoByTime` | userId | 所有视频 ID 列表 | 全部（含私密账号） |
| `getAuthorRecentAllPhotoId` | userId | 最近所有视频 ID | 全部（含私密账号） |
| `getAuthorAllPhotoIdByCursor` | userId | 分页所有视频 ID | 全部（含私密账号） |
| `getAuthorAllPhotoIdAfter` | userId | 指定 ID 后的所有视频 | 全部（含私密账号） |
| `getAuthorAllPhotoIdAfterTime` | userId | 指定时间后的所有视频 | 全部（含私密账号） |
| `getPhotoIdsWithDeleted` | userId | 含已删除视频 ID | 全部（含私密账号） |
| `getPhotoIdsWithoutDeleted` | userId | 未删除视频 ID | 全部（含私密账号） |
| `getPhotoIdWithDeletedFromDb` | userId | 含已删除视频 ID（DB） | 全部（含私密账号） |
| `getAuthorPublicPhotoByTime` | userId | 公开视频 ID 列表 | 仅公开 |
| `getAuthorRecentPublicPhotoId` | userId | 最近公开视频 ID | 仅公开 |
| `getAuthorPublicPhotoIdByCursor` | userId | 分页公开视频 ID | 仅公开 |
| `getAuthorPublicPhotoIdAfter` | userId | 指定 ID 后的公开视频 | 仅公开 |
| `getAuthorPrivatePhotoByTime` | userId | 仅自己可见视频 ID | 仅 PRIVATE |
| `getAuthorPhotoIdByCursor` | PhotoStatusQuery + userId | 取决于 PhotoStatusQuery 类型 | 由参数决定 |

**PhotoService / PhotoServiceRpcClient（photoId-based）**:

| 方法 | 参数 | 说明 |
|------|------|------|
| `getByIdFailFast` | photoId | 获取单个视频信息（含私密账号视频） |
| `getByIdsFailFast` | photoId 列表 | 批量获取视频信息 |
| `getByIdContainsDeleted` | photoId | 获取视频信息（含已删除） |
| `getByIdsContainsDeleted` | photoId 列表 | 批量获取（含已删除） |
| `getBasicPhotoById` | photoId | 获取基础视频信息 |
| `getBasicPhotoByIds` | photoId 列表 | 批量获取基础信息 |
| `getSomeByIds` | photoId 列表 | 获取部分视频信息 |
| `getSomeContainsDeleted` | photoId 列表 | 获取部分视频（含已删除） |
| `getByIdsContainsPending` | photoId 列表 | 获取视频（含待审核） |

**PhotoUrlService / PhotoUrlServiceRpcClient（photoId-based）**:

| 方法 | 参数 | 说明 |
|------|------|------|
| `getByIdFailFast` | photoId | 获取视频播放 URL |
| `getByIdsFailFast` | photoId 列表 | 批量获取播放 URL |
| `getByIdContainsDeleted` | photoId | 获取播放 URL（含已删除） |
| `getByIdsContainsDeleted` | photoId 列表 | 批量获取播放 URL |
| `getByIdsContainsPending` | photoId 列表 | 获取播放 URL（含待审核） |

**FeedViewService / FeedViewServiceRpcClient（photoId-based）**:

| 方法 | 参数 | 关键配置 |
|------|------|---------|
| `renderFeedView` | FeedRenderRequest（含 photoRequest.photoId） | `enable_feed_filter` 默认 false，为 true 时无漏洞 |

> **所有 SDK 方法均可查询到私密账号下的视频信息**。

---

### Step 4a: PhotoAuthorService 校验检查

**触发条件**: Step 3 确认为 userId-based 路径

**校验检查清单**（按优先级）:

| 检查项 | 安全条件 | 未满足时 |
|--------|---------|---------|
| friendTabRemovedUserClient.getBeReverseRemovedUser | 已调用且对当前访客做了阻断 | 不让ta看未校验 |
| SimpleFeedUtils.filterFeed / FeedUtils.filterFeed | 已调用并过滤了结果 | 视频过滤未做 |
| 只获取公开视频 + 判断了作者非私密账号 | 两者都满足 | 继续 |
| 前置判断了用户间业务关系 | 存在关系校验（如关注关系） | 继续 |

**安全判定**（以下任一满足即可）:
- 使用了 `friendTabRemovedUserClient.getBeReverseRemovedUser`，且对获取结果做了 `SimpleFeedUtils.filterFeed` 过滤（或满足下方免 filterFeed 条件）→ 安全
- 只获取了公开视频（如 `getAuthorRecentPublicPhotoId`）+ 判断了作者非私密账号 → 安全（免 friendTabRemovedUserClient 和 filterFeed）
- 前置判断了当前登录人与视频作者的业务关系 → 安全（免 friendTabRemovedUserClient 和 filterFeed）
- 以上都不满足 → 继续 Step 5

**禁止**:
- 仅因为使用了公开视频方法（如 `getAuthorRecentPublicPhotoId`）就认为安全（私密账号的公开视频也需校验）

---

### Step 4b: PhotoService/PhotoUrlService/FeedViewService 校验检查

**触发条件**: Step 3 确认为 photoId-based 路径

**校验检查清单**:

| 检查项 | 安全条件 | 适用 SDK |
|--------|---------|---------|
| SimpleFeedUtils.filterFeed / FeedUtils.filterFeed | 已调用并过滤了结果 | PhotoService / PhotoUrlService |
| enable_feed_filter = true | 已在 FeedRenderRequest 中设置 | FeedViewService |
| 只获取公开视频 + 判断了作者非私密账号 | 两者都满足 | 全部 |
| 前置判断了用户间业务关系 | 存在关系校验 | 全部 |

**安全判定**:
- 使用了 `SimpleFeedUtils.filterFeed` / `FeedUtils.filterFeed` → 安全
- FeedViewService 且 `enable_feed_filter = true` → 安全
- 只获取公开视频 + 判断了作者非私密账号 → 安全
- 前置判断了用户间业务关系 → 安全
- 以上都不满足 → 继续 Step 5

---

### Step 5: 三维度独立判定

**触发条件**: Step 4 确认无有效校验

**必做动作**: 对三个维度分别独立判定

**维度1: 隐私视频越权**
- 条件：photoId 可控 + SDK 获取视频信息 + 未做隐私视频状态校验 + 视频返回前端
- 判定：是 / 否

**维度2: 私密账号视频越权**
- 条件：userId/photoId 可控 + SDK 可获取私密账号视频 + 未做私密账号校验 + 视频返回前端
- 判定：是 / 否

**维度3: 绕过不让ta看**
- 条件：userId 可控 + 使用 PhotoAuthorService 获取视频列表 + 未调用 friendTabRemovedUserClient + 视频返回前端
- 判定：是 / 否

**汇总规则**: 任一维度为"是"→ 存在漏洞，继续 Step 6

---

### Step 6: HTTP 入口可达性

**触发条件**: Step 5 确认至少一个维度存在漏洞

**必做动作**: 追踪数据流到 HTTP/gRPC 入口点

**结束门槛**:
- 无 HTTP/gRPC 入口 → 风险-A
- 有 HTTP/gRPC 入口 → 漏洞

> HTTP 入口可达性检索：详见 [Java 通用检索技巧](java-common-retrieval.md#http-入口可达性检索)

---

### Step 7: 最终判定

综合 Step 0-6 所有检查结果，输出结论：

| 条件组合 | 最终结论 |
|---------|---------|
| SDK 返回值未到前端 | 安全 |
| 调用链不完整 | unknown |
| 参数不可控 | 安全 |
| 有完整校验（friendTabRemovedUserClient + filterFeed / filterFeed / enable_feed_filter） | 安全 |
| 有部分校验（如仅检查作者） | 风险-B |
| 无校验 + 无 HTTP 入口 | 风险-A |
| 无校验 + 有 HTTP 入口 | 漏洞 |

---

## 3. 常见漏洞/风险场景

### 3.1 漏洞场景

#### 场景1: userId-based — 获取所有视频无不让ta看校验

```java
@GetMapping("/user/{userId}/videos")
public List<VideoVO> getUserVideos(@PathVariable Long userId) {
    List<Long> photoIds = photoAuthorService.getAuthorRecentAllPhotoId(userId, 20);
    Map<Long, Photo> photos = photoService.getByIdsFailFast(photoIds);
    return convertToVOList(photos.values());  // 漏洞：无 friendTabRemovedUserClient，无 filterFeed
}
```

#### 场景2: userId-based — 获取公开视频但未校验私密账号

```java
@GetMapping("/user/{userId}/public-videos")
public List<VideoVO> getPublicVideos(@PathVariable Long userId) {
    List<Long> photoIds = photoAuthorService.getAuthorRecentPublicPhotoId(userId, 20);
    Map<Long, Photo> photos = photoService.getByIdsFailFast(photoIds);
    return convertToVOList(photos.values());  // 漏洞：userId 可能是私密账号，未做私密账号校验
}
```

#### 场景3: photoId-based — 获取视频信息无 filterFeed

```java
@GetMapping("/video/{photoId}")
public VideoVO getVideo(@PathVariable Long photoId) {
    Photo photo = photoService.getByIdFailFast(photoId);
    return convertToVO(photo);  // 漏洞：无 SimpleFeedUtils.filterFeed，可能是私密账号的视频
}
```

#### 场景4: photoId-based — FeedViewService 未启用 feed_filter

```java
public FeedViewResponse viewFeed(@RequestBody FeedRequest request) {
    PhotoRequestProto photoRequest = PhotoRequestProto.newBuilder()
        .setPhotoId(request.getPhotoId()).build();
    FeedRequest feedRequest = FeedRequest.newBuilder()
        .setPhotoRequest(photoRequest).build();
    FeedRenderRequest.Builder builder = FeedRenderRequest.newBuilder();
    // 未设置 setEnableFeedFilter(true)
    builder.addRequests(feedRequest);
    return feedViewServiceRpcClient.renderFeedView(builder.build());  // 漏洞
}
```

### 3.2 风险-B 场景

#### 场景5: 仅校验作者未校验公开状态

```java
Photo photo = photoService.getByIdFailFast(photoId);
if (!photo.getUserId().equals(currentUserId)) {
    throw new RuntimeException("无权限");
}
return convertToVO(photo);  // 风险-B：仅检查了作者，未检查视频是否公开
```

---

## 4. 常见防御模式

### 防御1: PhotoAuthorService — friendTabRemovedUserClient + SimpleFeedUtils.filterFeed

```java
public List<Photo> photoList(Long targetUserId) {
    // 不让ta看校验
    List<Long> removedUserList = friendTabRemovedUserClient
        .getBeReverseRemovedUser(targetUserId, Collections.singleton(CurrentScope.visitor()));
    if (removedUserList.contains(CurrentScope.visitor())) {
        throw new RuntimeException("无权限");
    }

    List<Long> photoIds = new ArrayList<>(photoAuthorService
        .getAuthorRecentPublicPhotoId(targetUserId, LIMIT).keySet());
    Map<Long, Photo> photos = photoService.getByIdsFailFast(photoIds);

    // 视频权限过滤
    BuildContext buildContext = new BuildContext(CurrentScope.visitor());
    viewBuilder.buildMulti(photos.values(), buildContext);

    List<Photo> result = new ArrayList<>();
    for (Photo photo : photos.values()) {
        if (SimpleFeedUtils.filterFeed(photo, buildContext)) {
            result.add(photo);
        }
    }
    return result;
}
```

**免 filterFeed 条件**：
- 只获取了非私密用户的公开视频列表 → 可不使用 `SimpleFeedUtils.filterFeed`
- 前置判断了当前登录人与视频作者在业务上存在关系 → 可不使用 `SimpleFeedUtils.filterFeed`

### 防御2: PhotoService/PhotoUrlService — SimpleFeedUtils.filterFeed

```java
public Photo photoInfo(Long photoId) {
    Photo photo = photoService.getByIdFailFast(photoId);
    BuildContext buildContext = new BuildContext(CurrentScope.visitor());
    viewBuilder.buildSingle(photo, buildContext);
    if (!SimpleFeedUtils.filterFeed(photo, buildContext)) {
        throw new RuntimeException("无权限");
    }
    return photo;
}
```

**免 filterFeed 条件**：
- 只获取了公开视频 + 判断了视频作者非私密用户 → 安全
- 判断了当前登录人与视频作者在业务上存在关系 → 安全

### 防御3: FeedViewService — enable_feed_filter

```java
public FeedViewResponse feedView(Long photoId) {
    PhotoRequestProto photoRequestProto = PhotoRequestProto.newBuilder()
        .setPhotoId(photoId).build();
    FeedRequest feedRequest = FeedRequest.newBuilder()
        .setPhotoRequest(photoRequestProto).build();

    FeedRenderRequest.Builder builder = FeedRenderRequest.newBuilder();
    builder.setEnableFeedFilter(true);  // 核心防护
    builder.addRequests(feedRequest);
    builder.setRequestInfo(ZtScope.clientRequestInfo());

    return feedViewServiceRpcClient.renderFeedView(builder.build());
}
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| SDK 调用 | `PhotoAuthorService`, `PhotoAuthorServiceRpcClient`, `PhotoService`, `PhotoServiceRpcClient`, `PhotoUrlService`, `PhotoUrlServiceRpcClient`, `FeedViewService`, `FeedViewServiceRpcClient` |
| 防御方法 | `friendTabRemovedUserClient`, `SimpleFeedUtils.filterFeed`, `FeedUtils.filterFeed`, `setEnableFeedFilter`, `enable_feed_filter` |
| 参数来源 | `request.getUserId()`, `CurrentScope.visitor()`, `@EspAccount`, `@Visitor`, `@PathVariable`, `@RequestParam` |

### 检测命令

```bash
# SDK 调用检测
grep -rn "PhotoAuthorService\|PhotoService\|PhotoUrlService\|FeedViewService" --include="*.java"

# 防御方法检测
grep -rn "friendTabRemovedUserClient\|SimpleFeedUtils\.filterFeed\|FeedUtils\.filterFeed\|setEnableFeedFilter\|enable_feed_filter" --include="*.java"

# 参数来源检测
grep -rn "request\.getUserId()\|CurrentScope\.visitor()\|@EspAccount\|@Visitor" --include="*.java"
```

---

## 6. 常见误判场景

### 陷阱1: 间接获取不算漏洞

**错误**: 看到 SDK 调用就认为有越权
**正确**: 参数为 tagId → 查 DB 得到 photoId → 调 SDK → 不算漏洞。对于从数据库或其他后端服务查询得到的 userId/photoId，一律视为不可控。

### 陷阱2: 简单数据处理仍视为直接传递

**错误**: 认为经过数据处理就不是直接传递
**正确**: 仅做去重、过滤 null、类型转换、封装到集合后传入 SDK，仍视为"直接传递"，参数仍视为可控。

### 陷阱3: 仅中间计算不算漏洞

**错误**: SDK 返回值在任何场景都算漏洞
**正确**: SDK 返回值仅用于条件判断/日志/统计/缓存/埋点/写入与前端无关的存储 → 未返回前端 → 安全。

### 陷阱4: 调用链不完整时应判 unknown

**错误**: 假设未给出的拦截器/切面提供防护
**正确**: 关键方法/类未给出、存在 `...`/`TODO` 占位符、依赖未提供的拦截器/切面/网关 → unknown。

### 陷阱5: 公开视频方法不等于安全

**错误**: 使用 `getAuthorRecentPublicPhotoId` 就安全
**正确**: 私密账号的公开视频也需私密账号校验。用户 A 查私密账号 B 的公开视频，仍需判断 A 是否有权限查看 B 的公开视频。

### 陷阱6: 混淆 SDK 方法范围

**错误**: 认为 PhotoService 只返回公开视频
**正确**: 所有 SDK 方法（PhotoAuthorService/PhotoService/PhotoUrlService/FeedViewService）均可查询到私密账号下的视频信息。

---

## 7. 特殊风险

### 视频状态枚举

| 状态 | 说明 |
|------|------|
| PUBLIC | 公开视频 |
| PRIVATE | 仅自己可见 |
| FRIEND | 互关好友可见 |
| PARTIALLY_VISIBLE | 部分用户可见 |
| PARTIALLY_INVISIBLE | 部分用户不可见 |

**隐私视频定义**: PRIVATE、FRIEND、PARTIALLY_VISIBLE、PARTIALLY_INVISIBLE 均属于隐私视频。

### 账号状态

| 状态 | 说明 |
|------|------|
| 公开账号 | 任何人可查看公开视频 |
| 私密账号 | 查看公开视频需关注申请 + 作者审批通过 |
| 封禁账号 | - |

### 用户关系

| 关系 | 对视频可见性的影响 |
|------|-----------------|
| 用户 A 被用户 B 拉黑 | A 无法查看 B 的视频 |
| 用户 A 被用户 B 设置不让ta看 | A 无法查看 B 的主页视频列表，但仍可通过分享查看 B 的单个视频 |

### SDK 能力矩阵

> **所有 SDK 方法均可查询到私密账号下的视频信息**

| SDK | 能查私密账号视频 | 特殊说明 |
|-----|:---:|---------|
| PhotoAuthorService | 是 | 所有方法（含 Public 方法） |
| PhotoService | 是 | 所有方法 |
| PhotoUrlService | 是 | 所有方法 |
| FeedViewService | 是 | `enable_feed_filter=false` 时（默认） |

### 修复方案参考

https://docs.corp.kuaishou.com/d/home/fcAAkJkML5JAjXRjsYQt08UQk

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增视频 SDK 调用 | 确认返回值用途、参数来源、校验逻辑 |
| 新增 | 新增 PhotoAuthorService 调用 | 确认不让ta看校验 + filterFeed |
| 新增 | 新增 FeedViewService 调用 | 确认 enable_feed_filter 设置 |
| 修改 | 移除 friendTabRemovedUserClient 校验 | 引入不让ta看绕过风险 |
| 修改 | 移除 SimpleFeedUtils.filterFeed | 引入私密账号视频泄露风险 |
| 修改 | enable_feed_filter 从 true 改为 false | 引入隐私视频过滤绕过风险 |
| 修改 | SDK 返回值新增写入前端返回值 | 扩大数据泄露面 |
| 删除 | 删除 friendTabRemovedUserClient 调用 | 移除不让ta看防护 |
| 删除 | 删除 SimpleFeedUtils.filterFeed 调用 | 移除视频过滤防护 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] **SDK 返回值是否到达前端**已确认（视频信息是否写入 Response/VO/DTO/Map 返回值）
- [ ] **调用链完整性**已确认（无 `...`/`TODO`/关键方法缺失）
- [ ] **参数来源**已确认（userId/photoId 来自接口入参 vs DB/后端查询）
- [ ] **SDK 方法分类**已确认（PhotoAuthorService vs PhotoService/PhotoUrlService/FeedViewService）
- [ ] **对应 SDK 的校验检查**已完成（friendTabRemovedUserClient / SimpleFeedUtils.filterFeed / enable_feed_filter）
- [ ] **三个维度各自独立判定**（隐私视频 / 私密账号 / 不让ta看）
- [ ] **HTTP 入口可达性**已确认
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
