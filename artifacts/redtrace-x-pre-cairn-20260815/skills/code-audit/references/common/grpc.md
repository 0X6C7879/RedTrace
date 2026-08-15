# gRPC 框架特性

## 核心原则

- **proto 定义的字段除身份凭据外均为用户可控**
- 参数类型定义在 .proto 文件中
- gRPC 方法入参来自 .proto 文件定义的消息类（Message），而非直接的 Java 类型定义

---

## 快手 KESS-RPC 框架特性

### 框架概述

快手基于标准 gRPC 实现了 KESS-RPC 框架，集成服务注册发现、流量调度、限流熔断降级等服务治理能力。

### 两种使用模式

| 模式 | 说明 | 推荐程度 |
|------|------|----------|
| KsBoot 框架 | 简化配置方式，使用 @KrpcService 等注解 | 推荐 |
| 旧版框架 | 需要定义 RpcConfig 枚举类 | 维护老项目时使用 |

### SDK 模块结构

- SDK 子项目命名：`{父项目名称}-sdk`
- SDK 依赖：`infra-krpc-metadata`、`krpc-all`、`ks-boot-starter-krpc`
- .proto 文件位置：`{project}-sdk/src/main/proto/**/*.proto`

---

## gRPC 识别模式

### 标准 gRPC 模式

| 模式 | 说明 |
|------|------|
| `extends XXXServiceGrpc.XXXServiceImplBase` | gRPC 服务实现类 |
| `@GrpcService` | Spring gRPC 注解 |
| 类名包含 `Proto`、`OuterClass` | 生成的 proto 类 |
| 方法参数为 `StreamObserver` | gRPC 流式响应 |
| 包含 `io.grpc` 相关导入 | gRPC 框架 |

### 快手 KESS-RPC 模式

| 模式 | 说明 |
|------|------|
| `extends KrpcXXXGrpc.XXXImplBaseV2` | 新版服务实现基类 |
| `extends XXXGrpc.XXXServiceImplBaseV2` | 旧版服务实现基类 |
| `@KrpcService` | KsBoot 服务注解 |
| `@KrpcReference` | 客户端引用注解 |
| `@EnableKrpc` | 启动类启用注解 |
| `com.kuaishou.krpc` / `com.kuaishou.infra.boot` 导入 | KESS-RPC 包名 |
| `@KsBootApplication` | KsBoot 启动类注解 |

---

## 服务端实现识别

### 新版 KsBoot 框架

```java
@KrpcService
public class DemoGreetingServiceRpc extends DemoGreetingServiceImplBaseV2 {
    @Override
    public GreetingResponse hello(Person request) throws Throwable {
        // 业务实现
    }
}
```

**特征**：
- 继承 `KrpcXXXGrpc.XXXImplBaseV2` 或 `XXXGrpc.XXXServiceImplBaseV2`
- 使用 `@KrpcService` 注解
- 启动类使用 `@EnableKrpc` 注解

---

## 客户端调用识别

### 注解注入方式（推荐）

```java
@RestController
public class HelloController {

    @KrpcReference(serviceName = "infra-demo-service")
    private IDemoGreetingService client;

    @RequestMapping("hello")
    public String hello() {
        return client.hello(...);
    }
}
```

**特征**：
- 使用 `@KrpcReference` 注解
- 注入接口类型为 `KrpcXXXGrpc.IXXX`

---

## 参数可控性判定原则（核心）

### 身份凭据字段（不可控，拦截器注入）

以下字段通常由 gRPC 拦截器从认证信息中提取并注入：

| 字段名 | 说明 |
|--------|------|
| `userId` | 用户 ID |
| `sellerId` | 商家 ID |
| `merchantId` | 商户 ID |
| `accountId` | 账户 ID |
| `sessionId` | 会话 ID |
| `token` / `authToken` | 认证令牌 |

**判定时需确认**：字段是否由拦截器设置（用户无法篡改）

### 用户可控字段（除上述外）

- **所有业务字段**：proto 中定义的业务字段均为用户可控
- **嵌套 message 字段**：包括嵌套消息中的所有字段
- **repeated 字段**：数组类型字段
- **oneof 字段**：联合类型字段
- **map 字段**：键值对字段

---

## 身份凭据判定规则（无需检索拦截器）

**重要**：userId/sellerId 等字段由上游网关注入，当前代码仓库无拦截器代码。

### 判定逻辑

- **字段名为 userId/sellerId/merchantId/accountId/sessionId/token 等** → 不可控（安全）
- **其他业务字段** → 用户可控（需继续研判）

**无需搜索拦截器代码**，直接基于字段名判定。

---

## 框架识别速查表

| 特征 | 标准 gRPC | 快手 KESS-RPC |
|------|-----------|---------------|
| 服务注解 | @GrpcService | @KrpcService |
| 客户端注解 | @GrpcClient | @KrpcReference |
| 启用注解 | @EnableGrpc | @EnableKrpc |
| 实现基类 | XXXServiceImplBase | XXXImplBaseV2 |
| 包名前缀 | io.grpc | com.kuaishou.krpc |
| proto 生成 | 自动 | SDK 子项目 |
| 服务配置 | 无 | RpcConfig 枚举（旧版） |

---

## gRPC 参数来源示例

### 安全：拦截器注入的身份凭据

```java
// 拦截器代码
public class AuthInterceptor implements ServerInterceptor {
    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
        ServerCall<ReqT, RespT> call, Metadata headers,
        ServerCallHandler<ReqT, RespT> next) {

        String userId = headers.get(Metadata.Key.of("user-id", Metadata.ASCII_STRING_MARSHALLER));

        // 将 userId 注入到请求上下文
        Context ctx = Context.current().withValue(USER_ID_KEY, userId);
        return Contexts.interceptCall(ctx, call, headers, next);
    }
}

// Service 方法中获取（安全）
String userId = Context.USER_ID_KEY.get(); // 拦截器注入，用户不可控
```

### 危险：用户可控的业务字段

```java
// proto 定义
message GetUserRequest {
    string keyword = 1;      // 用户可控的搜索关键词
    string username = 2;     // 用户可控
    string sort_column = 3;  // 用户可控
}

// Service 实现
public void getUser(GetUserRequest request, StreamObserver<UserResponse> responseObserver) {
    // request.getKeyword() 来自用户输入，可控！
    String keyword = request.getKeyword();  // 用户可控，需检查是否用于危险操作
}
```

---

## gRPC 与 REST Controller 参数来源对比

| 特性 | REST Controller | gRPC Service |
|------|----------------|--------------|
| 参数定义 | Java 方法签名中直接定义 | `.proto` 文件中定义 message |
| 参数类型 | Java 原生类型/自定义类 | Protocol Buffer 类型 |
| 注解识别 | `@RequestParam`、`@RequestBody` | 无注解，通过 proto 定义识别 |
| 类型查看 | 直接在 Java 文件中可见 | 需要查找对应的 `.proto` 文件 |
| 身份凭据 | SessionContext / UserContext | gRPC Metadata / Context |
| proto 文件位置 | N/A | `src/main/proto/` 目录 |
