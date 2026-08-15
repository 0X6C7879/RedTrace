# 隐私视频越权

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> SDK 返回值不返回前端 = 无隐私视频越权（这是漏洞本质判断，不是防护有效判断）
>
> **注意**：以下情况均视为"返回前端"：
> - 直接将 Photo/VideoInfo 等对象序列化返回
> - 返回视频文件路径、rawKey、bucketName、播放 URL、缩略图 URL 等可访问视频内容的字段
> - 敏感字段进入任何会被前端接收的数据结构（如 MessageInfo、SSE 事件、WebSocket 消息），即使经过 AI 模型等中间组件转发，仍视为返回前端
>
> SDK 返回值仅用于后端逻辑判断（如状态比对、日志记录）且不含上述字段时，才可终止分析。

**强制执行顺序**：
1. **首先**：确认 SDK 返回值是否到达前端（含文件路径/URL 等间接可访问字段）
2. **然后**：确认 photoId 是否用户可控
3. **仅当** 返回值到达前端且 photoId 可控时，才检查校验逻辑
4. **禁止**：一上来就检查"有没有校验作者"

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 用户可通过 HTTP/gRPC 入口访问他人隐私视频 | photoId 前端可控 + 无作者/状态校验 + 视频信息返回前端 |
| **风险-A** | SDK 调用但无 HTTP/gRPC 入口可达 | SDK 调用 + 无外部入口 |
| **风险-B** | 有入口可达但校验不充分 | 有部分校验（如仅检查作者未检查公开状态） |
| **安全** | 无危险写法，或有充分校验 | 返回值仅后端使用 / 作者+状态完整校验 / gRPC 网关注入 / 非线上 |

---

## 2. 研判思路

### 2.1 关键 SDK 列表（第一优先级）

| SDK 类/接口 | 方法 | 说明 |
|------------|------|------|
| PhotoAuthorServiceRpcClient | getPhotoAuthor(photoId) | 获取视频作者信息 |
| PhotoServiceRpcClient | getPhoto(photoId) | 获取视频元数据 |
| PhotoServiceRpcClient | batchGetPhoto(ids) | 批量获取视频 |
| PhotoUrlServiceRpcClient | getPhotoUrl(photoId) | 获取视频播放 URL |
| FeedViewServiceRpcClient | renderFeedView(request) | 获取 Feed 流视频 |

### 2.2 研判流程

```
Step 1: SDK 返回值用途 【终止点】
  ├─ 仅后端判断（条件/计数/审核）？ → 安全（终止）
  ├─ 写入日志/存储？ → 安全（终止）
  └─ 返回给前端（Response/DTO） → 继续

Step 2: photoId 来源检查 【终止点】
  ├─ gRPC 网关注入（request.getUserId()）？ → 安全（终止）
  ├─ 数据库查询结果？ → 安全（终止）
  ├─ @PathVariable/@RequestParam/@RequestBody photoId？ → 继续
  └─ 内部计算/配置？ → 安全（终止）

Step 3: 校验逻辑检查
  ├─ 完整校验（作者 + 公开状态）？ → 安全（终止）
  ├─ 仅检查作者或仅检查状态？ → 风险-B
  └─ 无校验 → 继续

Step 4: HTTP 入口可达性 【终止点】
  ├─ 无 HTTP/gRPC 入口？ → 风险-A
  └─ 有 HTTP/gRPC 入口 → 漏洞
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| SDK 返回值仅后端使用 | 漏洞 | 安全 |
| gRPC 网关注入 userId | 漏洞 | 安全 |
| 完整校验（作者+状态） | 漏洞 | 安全 |
| 非线上环境 | 漏洞 | 安全 |
| 仅检查作者或仅检查状态 | 漏洞 | 风险-B |
| 无 HTTP 入口 | 漏洞 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 漏洞

```java
// photoId 前端可控，无作者校验
@GetMapping("/video/{photoId}")
public VideoVO getVideo(@PathVariable Long photoId) {
    PhotoInfo photo = photoServiceRpcClient.getPhoto(photoId);
    return convertToVO(photo);  // 漏洞：未校验作者和公开状态，直接返回
}
```

### 风险-B（校验不充分）

```java
// 仅检查作者，未检查公开状态
if (photo.getAuthorId().equals(userId)) {
    return convertToVO(photo);  // 风险-B：隐私视频状态未检查
}
```

---

## 4. 常见防御模式

### SDK 返回值仅后端使用

```java
PhotoInfo photo = photoServiceRpcClient.getPhoto(photoId);
if (photo.getAuthorId().equals(userId)) {
    auditLog.log("Access granted");  // 安全：仅后端判断
}
```

### 完整校验（作者 + 状态）

```java
PhotoInfo photo = photoServiceRpcClient.getPhoto(photoId);
if (!photo.getAuthorId().equals(userId) && photo.getStatus() != Status.PUBLIC) {
    throw new AccessDeniedException();  // 安全：完整校验
}
```

---

## 5. 检索技巧

### 搜索关键词

| 类型 | 关键词 |
|------|--------|
| SDK 调用 | `PhotoServiceRpcClient`, `PhotoUrlServiceRpcClient`, `FeedViewServiceRpcClient` |
| 校验 | `getAuthorId`, `getStatus`, `isPublic` |

### 检测命令

```bash
grep -rn "PhotoServiceRpcClient\|PhotoUrlServiceRpcClient\|PhotoAuthorServiceRpcClient" --include="*.java"
```

---

## 6. 常见误判场景

### 陷阱1：SDK 调用误判

**错误**: 看到 SDK 调用就认为有越权
**正确**: SDK 返回值仅用于后端逻辑判断 → 安全

### 陷阱2：gRPC userId 误判

**错误**: 看到参数就认为用户可控
**正确**: `request.getUserId()` 由 gRPC 网关注入，用户不可伪造 → 安全

### 陷阱3：混淆视频 ID 和用户 ID

**错误**: 认为 photoId 是安全的
**正确**: photoId 是视频 ID（前端可控），userId 是身份 ID（网关注入），两者安全级别不同

### 陷阱4：AI 聊天场景间接泄露误判

**错误**: 敏感字段发送给 AI 模型（而非直接序列化返回）→ 认为不返回前端 → safe
**正确**: AI 模型响应通过 SSE/WebSocket 流式返回前端，敏感字段（如 rawKey、bucketName）进入 MessageInfo 后随 AI 响应间接暴露给前端，仍视为"返回前端"，需检查权限校验

---

## 7. 特殊风险

### 视频状态枚举

| 状态 | 值 | 说明 |
|------|-----|------|
| PUBLIC | 0 | 公开视频 |
| PRIVATE | 1 | 仅自己可见 |
| FRIEND | 2 | 互关好友可见 |
| PARTIALLY_VISIBLE | 3 | 部分用户可见 |
| PARTIALLY_INVISIBLE | 4 | 部分用户不可见 |

**隐私视频定义**: PRIVATE、FRIEND、PARTIALLY_VISIBLE、PARTIALLY_INVISIBLE 均属于隐私视频。判断"是否隐私视频"时，状态值 ≥ 1 即为隐私视频。

### 常见校验方式

| 校验类型 | 代码示例 | 说明 |
|---------|---------|------|
| 作者校验 | `photo.getUserId() != userId` | 检查视频作者是否是当前用户 |
| 状态校验 | `photo.getPhotoStatus() != DB_PHOTO_PHOTOSTATUS_PUBLIC` | 检查视频是否公开 |
| 默认请求选项 | `PhotoRequestOption.defaultRequestOption()` | 只查询公开视频 |
| Feed过滤 | `setEnableFeedFilter(true)` | 过滤非公开视频 |

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增视频 SDK 调用 | 确认返回值用途和校验 |
| 修改 | 移除作者/状态校验 | 引入越权风险 |
| 修改 | 返回值新增前端字段 | 扩大数据泄露面 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] SDK 返回值是否到达前端已确认（含 AI/SSE/WebSocket 间接泄露场景）
- [ ] photoId 来源已确认（前端可控 vs 网关注入）
- [ ] 校验逻辑完整性已确认（作者+状态）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
