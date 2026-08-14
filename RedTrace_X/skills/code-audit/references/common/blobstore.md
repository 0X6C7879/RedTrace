# BlobStore 对象存储

**BlobStore 是快手自研的对象存储服务，兼容 S3 协议，用于安全存储非结构化数据。**

## 背景

BlobStore 是公司内对象存储的统一入口，适合存放文本、图片、视频、音频等各类非结构化数据。兼容 S3 访问协议，可通过 HTTP RESTful API、S3 SDK、AWS CLI 等方式管理数据。

## 核心原则

1. **统一存储**：作为公司统一的对象存储入口，有完善的安全措施
2. **环境隔离**：PROD/CANDIDATE/STAGING 环境之间互相独立
3. **Region 隔离**：不同地域的数据存储隔离，不能跨 Region 访问
4. **强一致性**：同环境下上传后立即可读，跨环境不保证
5. **数据冗余**：采用纠删码、多副本机制确保数据持久性

## 核心概念

| 概念 | 说明 |
|------|------|
| Bucket | 存储桶，对象的载体，扁平化结构无文件夹概念 |
| Object | 对象/文件，数据存储的基本单元 |
| Region | 地域，表示数据中心所在位置（HB1、SGP 等） |
| Environment | 环境，PROD/CANDIDATE/STAGING 三种环境 |
| Engine | 存储引擎，SIMPLE（自研）/COS/GCS/S3 |
| Endpoint | 访问域名，不同 Region 有不同域名 |
| AK/SK | 访问密钥，用于鉴权认证 |

## 环境与 Region

### 环境类型

| 环境 | 说明 | 网络 |
|------|------|------|
| PROD | 线上环境 | IDC 内网 |
| CANDIDATE | 测试环境 | 办公网 |
| STAGING | Staging 环境 | 办公网 |

### Region 列表

| Region ID | 说明 | 支持的存储引擎 |
|-----------|------|--------------|
| HB1 | 华北一区 | SIMPLE、COS |
| SGP | 新加坡 | COS、GCS（不支持新建）、S3（不支持新建） |

### Endpoint 规则

| 环境 | Endpoint 格式 | 说明 |
|------|--------------|------|
| PROD | `bs3-{region}.internal` | 仅 IDC 内可访问 |
| STAGING | `bs3-{region}.staging.kuaishou.com` | 支持 http/https |
| 办公网 | `bs3-{region}.corp.kuaishou.com` | 仅下载，无 SLA |

## 代码模式识别

### Java 模式

| 模式 | 说明 |
|------|------|
| `BS3Client` / `BS3ClientConfig` | 新版 SDK 客户端 |
| `BlobStoreClient` / `BlobStoreTable` | 旧版 SDK（已进入 Maintain 状态） |
| `bs3.putObject()` | 上传对象到 BlobStore |
| `bs3.uploadPart()` | 分片上传 |
| `bs3.getObject()` | 下载对象 |
| `bs3.copyObject()` | 拷贝对象 |
| `bs3.deleteObject()` | 删除对象 |
| `bs3.getUrl()` | 生成办公网 URL |
| `bs3.getInternalUrl()` | 生成 IDC URL |
| `bs3.generateCdnUri()` | 生成 CDN URI |
| `blobstore.upload()` | 旧版上传方法 |
| `BlobStoreTableInfo` / `BS2BucketFactory` | Bucket 工厂方法 |

### Bucket 命名规则

| 模式 | 说明 |
|------|------|
| `bucketName + "-" + tableName` | 命名规则 |
| `db + "-" + table` | 旧 SDK 命名转换 |

### AK/SK 认证模式

| 模式 | 说明 |
|------|------|
| `AWSStaticCredentialsProvider` | 静态 AK/SK 凭证 |
| `BasicAWSCredentials(ak, sk)` | 基本凭证构造 |
| `kconf.getString("ak/sk")` | 从 Kconf 获取密钥 |

## 文件上传相关 API

| 方法 | 说明 | 大小限制 |
|------|------|---------|
| `putObject()` | 简单上传 | 最大 5GB |
| `initiateMultipartUpload()` + `uploadPart()` + `completeMultipartUpload()` | 分片上传 | 最大 2TB，分片 1MB-200MB |

## 禁止的误判

**错误判定**：
> 代码使用 BlobStore 存储，但未确认 Bucket ACL 设置 → 无法判断安全性

**正确判定**：
> BlobStore 是公司统一对象存储服务，使用 BlobStore 存储文件默认为安全防护措施 → 安全（统一存储）

**错误判定**：
> AK/SK 可能泄露，不安全 → 需要验证密钥来源

**正确判定**：
> AK/SK 来自 Kconf 配置，Kconf 为研发自配置且用户无法篡改的可信数据源 → 安全（密钥可信）

## 代码示例

```java
// 安全：新版 SDK 上传
BS3ClientConfig config = BS3ClientConfig.builder()
    .regionProvider(new HB1RegionProvider())
    .credentialsProvider(new AWSStaticCredentialsProvider(
        new BasicAWSCredentials(ak, sk)))
    .build();
BS3Client bs3 = BS3Client.create(config);

ObjectMetadata metadata = new ObjectMetadata();
metadata.setContentLength(data.length);
metadata.setContentType("image/jpeg");
RequestBody body = RequestBody.fromBytes(data);
bs3.putObject("bucketName", "key", body, metadata);

// 安全：旧版 SDK 上传
BlobStoreClient blobstore = BlobStoreClientFactory.create();
String url = blobstore.upload(file.getInputStream(), fileName);

// 安全：分片上传
InitiateMultipartUploadResult result = bs3.initiateMultipartUpload(
    new InitiateMultipartUploadRequest("bucket", "key"));
String uploadId = result.getUploadId();
// ... 上传分片
bs3.completeMultipartUpload(new CompleteMultipartUploadRequest("bucket", "key", uploadId, parts));

// 安全：从 Kconf 获取 AK/SK
String ak = kconf.getString("blobstore.ak");
String sk = kconf.getString("blobstore.sk");
```

## 注意事项

1. **强一致性限制**：跨环境调用不保证一致性，如 PROD 上传后 CANDIDATE 立即下载可能失败
2. **Region 隔离**：不同 Region 之间不能拷贝数据
3. **BS3Client 单例**：BS3Client 创建成本高昂，必须维护单例
4. **旧版 SDK**：已进入 Maintain 状态，建议迁移到新版 BS3 SDK
5. **办公网 Endpoint**：仅支持下载，不提供 SLA，线上环境无法访问
