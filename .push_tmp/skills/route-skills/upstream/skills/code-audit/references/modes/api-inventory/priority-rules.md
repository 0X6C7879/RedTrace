# API 优先级分类规则

## 一、分类维度（6 个核心维度）

### 0. 接口环境/类型（优先级降级因子）

| 类型 | 降级幅度 | 特征关键词 | 说明 |
|------|----------|------------|------|
| 测试接口 | -2 级 | test, mock, stub, debug, sandbox, dev, beta, staging | 测试环境专用接口 |
| 管理员接口 | -1 级 | admin, manage, backend, system, mgmt | 需要管理员权限的接口 |
| 内部接口 | -1 级 | internal, inner, private, local, localhost, 127.0.0.1 | 服务间调用或内网接口 |
| gRPC 服务间调用 | -1 级 | http_method=RPC | gRPC 服务间内部调用（非 HTTP 入口） |
| 监控/健康检查 | -2 级 | health, ping, metrics, monitor, status, heartbeat | 监控探针接口 |

**路径特征识别**：
- 路径前缀：`/internal/`, `/admin/`, `/test/`, `/debug/`, `/api/v1/internal/`
- 域名特征：`test.`, `dev.`, `staging.`, `internal.`, `admin.`
- 注解标记：`@Internal`, `@AdminOnly`, `@TestOnly`

### 1. 业务敏感度

| 级别 | 评分 | 业务类型 | 典型接口 |
|------|------|----------|----------|
| Critical | 10 | 资金交易 | 支付、退款、提现、转账、充值 |
| Critical | 10 | 认证授权 | 登录、注册、密码重置、OAuth、Token签发 |
| High | 8 | 权限管理 | 角色分配、权限变更、成员管理 |
| High | 7 | 敏感数据 | PII（身份证、手机号）、银行卡、合同、资质 |
| Medium | 5 | 核心业务 | 订单、合同、账户配置 |
| Low | 3 | 一般业务 | 查询、列表、字典数据 |
| Low | 1 | 公开数据 | 公告、帮助、公开配置 |

### 2. 操作类型

| 级别 | 评分 | 操作类型 | 风险说明 |
|------|------|----------|----------|
| High | 5 | 写操作 (POST/PUT/DELETE) | 数据变更，影响面大 |
| High | 5 | 文件上传 | 可能有路径遍历、恶意文件 |
| Medium | 4 | 文件下载 | 可能有路径遍历、敏感文件泄露 |
| Medium | 3 | 批量操作 | 可能有 DoS、越权批量访问 |
| Low | 2 | 单条查询 (GET) | 风险相对较低 |
| Low | 1 | 公开查询 | 无认证要求，数据公开 |

### 3. 数据敏感度

| 级别 | 评分 | 数据类型 | 合规风险 |
|------|------|----------|----------|
| Critical | 10 | 支付凭证/密码/密钥 | 支付安全、密钥泄露 |
| Critical | 9 | 实名信息（身份证、人脸） | 个人隐私保护法 |
| High | 8 | 手机号/邮箱/地址 | PII 保护 |
| High | 7 | 银行卡/财务数据 | 金融安全 |
| High | 6 | 合同/资质文件 | 商业机密 |
| Medium | 4 | 业务配置数据 | 业务逻辑泄露 |
| Low | 2 | 公开业务数据 | 无 |

### 4. 暴露面

| 级别 | 评分 | 特征 | 典型漏洞类型 |
|------|------|------|--------------|
| Critical | 10 | 无认证公开接口 | 认证绕过、匿名攻击 |
| Critical | 10 | 命令/脚本执行 | RCE |
| Critical | 10 | 反序列化操作 | 反序列化（可 RCE） |
| Critical | 10 | 模板渲染（用户输入） | SSTI |
| High | 8 | 文件上传（可执行文件） | 恶意文件上传、RCE |
| High | 8 | 文件下载/路径操作 | 路径遍历、敏感文件泄露 |
| High | 7 | 外部请求/代理 | SSRF（可访问内网） |
| High | 7 | XML 解析 | XXE（文件读取） |
| High | 6 | SQL 拼接 | SQL 注入 |
| High | 6 | NoSQL 查询拼接 | NoSQL 注入 |
| High | 6 | 用户输入存储输出 | 存储型 XSS |
| Medium | 4 | 用户输入反射输出 | 反射型 XSS |
| Medium | 4 | 状态变更操作 | CSRF |
| Medium | 4 | Token/认证处理 | JWT 问题、原型链污染 |
| Low | 2 | JSON API | 相对安全 |
| Low | 2 | URL 重定向/跨域 | 开放重定向、CORS |
| Low | 1 | 硬编码/配置 | 硬编码凭据、信息泄露、Debug 开启 |
| Low | 1 | 静态资源 | 低风险 |

### 5. 认证要求

| 级别 | 评分 | 认证类型 | 风险说明 |
|------|------|----------|----------|
| Critical | 10 | 无认证 | 未授权用户可直接访问 |
| High | 6 | 弱认证（仅登录） | 可能存在 IDOR |
| Medium | 4 | 角色认证 | 可能有权限提升 |
| Low | 2 | 强认证（MFA + 权限） | 防护较完善 |

## 二、综合评分公式

```
基础分数 = 业务敏感度 + 操作类型 + 数据敏感度 + 暴露面 + 认证要求
优先级分数 = 基础分数 - 环境降级因子
总分范围：5 - 45 分
```

**降级规则**：
- 测试接口：基础分数 - 10 分（约降 2 级）
- 监控/健康检查：基础分数 - 10 分（约降 2 级）
- 管理员接口：基础分数 - 5 分（约降 1 级）
- 内部接口：基础分数 - 5 分（约降 1 级）

## 三、优先级分级标准

| 优先级 | 分数范围 | 审计要求 | 典型特征 |
|--------|----------|----------|----------|
| P0 | 35-45 | 必须全量审计 | 支付、认证、文件上传、无认证敏感接口 |
| P1 | 25-34 | 重点审计 | 文件下载、PII 数据、权限管理、外部请求 |
| P2 | 15-24 | 抽样审计 | 核心业务写操作、批量操作、敏感查询 |
| P3 | 5-14 | 可选审计 | 一般查询、公开数据、有认证的普通接口 |

## 四、快速识别关键词

### P0 - 最高优先级（必须审计）

| 分类 | 特征关键词 |
|------|------------|
| 资金交易 | pay, payment, refund, withdraw, transfer, recharge |
| 认证授权 | login, register, signup, password, token, oauth, sso, auth |
| 文件上传 | upload, multipart, file-upload |
| 验证码 | send-code, verify-code, captcha, sms |
| 命令执行 | exec, command, script, eval, process, shell, runtime, subprocess |
| 反序列化 | deserialize, readObject, pickle, yaml.load, unmarshal, from_json |
| 模板注入 | template, render, jinja, freemarker, thymeleaf, velocity, mako, erb |

### P1 - 高优先级（重点审计）

| 分类 | 特征关键词 |
|------|------------|
| 文件下载 | download, export, file, attachment |
| 实名/PII | idcard, phone, email, address, realname, id_no |
| 权限管理 | role, permission, member, admin, grant, authorize |
| 外部请求 | proxy, fetch, request, callback, webhook |
| 合同/资质 | contract, cert, qualification, license |
| SQL 操作 | sql, query, native, execute, jpa, mybatis, jdbc |
| NoSQL 操作 | mongo, nosql, find, aggregate, where, collection |
| XML 解析 | xml, sax, dom4j, jackson-xml, xmlreader, documentbuilder |
| 存储型输出 | sanitize, escape, innerhtml, v-html, dangerouslySetInnerHTML |

### P2 - 中优先级（抽样审计）

| 分类 | 特征关键词 |
|------|------------|
| 核心业务写 | create, update, delete, submit, approve, reject |
| 批量操作 | batch, bulk, multi, all |
| 配置管理 | config, setting, preference |
| 组织管理 | org, team, group, member |
| 绑定操作 | bind, unbind, assign |
| 反射型输出 | reflect, redirect, param, input, echo, return_body |
| CSRF 相关 | csrf, _token, referer, origin, x-requested-with |
| JWT/认证 | jwt, jsonwebtoken, jws, jwe, session, cookie |

### P3 - 一般优先级（可选审计）

| 分类 | 特征关键词 |
|------|------------|
| 一般查询 | list, query, get, search, detail, info |
| 公开数据 | public, common, enum, dict |
| 字典数据 | category, type, status, options |
| 低风险漏洞 | cors, allow-origin, redirect_url, debug, trace, stacktrace |
| 硬编码/配置 | hardcoded, secret, apikey, private_key, credential |

## 五、分类决策树

```
接口输入
    │
    ├─ 【Step 1: 环境类型判断】
    │   ├─ 测试/监控接口？ → 记录降级 -2 级
    │   ├─ 管理员/内部接口？ → 记录降级 -1 级
    │   └─ 生产接口 → 无降级
    │
    ├─ 【Step 2: 基础优先级判断】
    │   │
    │   ├─ 是否涉及资金交易？
    │   │   └─ 是 → 基础 P0
    │   │
    │   ├─ 是否涉及认证授权？
    │   │   └─ 是 → 基础 P0
    │   │
    │   ├─ 是否涉及文件上传？
    │   │   └─ 是 → 基础 P0
    │   │
    │   ├─ 是否涉及命令执行/反序列化/SSTI？
    │   │   └─ 是 → 基础 P0
    │   │
    │   ├─ 是否涉及 SQL/NoSQL 拼接？
    │   │   └─ 是 → 基础 P1
    │   │
    │   ├─ 是否涉及 XML 解析？
    │   │   └─ 是 → 基础 P1
    │   │
    │   ├─ 是否无认证 + 敏感操作？
    │   │   └─ 是 → 基础 P0
    │   │
    │   ├─ 是否涉及文件下载？
    │   │   └─ 是 → 基础 P1
    │   │
    │   ├─ 是否涉及 PII 数据？
    │   │   └─ 是 → 基础 P1
    │   │
    │   ├─ 是否涉及权限管理？
    │   │   └─ 是 → 基础 P1
    │   │
    │   ├─ 是否涉及外部请求？
    │   │   └─ 是 → 基础 P1
    │   │
    │   ├─ 是否为核心业务写操作？
    │   │   └─ 是 → 基础 P2
    │   │
    │   ├─ 是否为批量操作？
    │   │   └─ 是 → 基础 P2
    │   │
    │   └─ 一般查询/公开数据
    │       └─ 基础 P3
    │
    └─ 【Step 3: 应用降级】
        └─ 最终优先级 = 基础优先级 - 降级级数（最低 P3）
```

## 六、降级示例

| 接口路径 | 基础优先级 | 接口类型 | 降级 | 最终优先级 |
|----------|------------|----------|------|------------|
| `/api/payment` | P0 | 生产 | 0 | **P0** |
| `/api/test/payment` | P0 | 测试 | -2 | **P2** |
| `/internal/admin/user/delete` | P1 | 内部+管理员 | -2 | **P3** |
| `/admin/upload` | P0 | 管理员 | -1 | **P1** |
| `/health` | P1 | 监控 | -2 | **P3** |
| `/api/user/list` | P3 | 生产 | 0 | **P3** |

## 七、API 描述分类标签规范

### 标签体系

**一级分类**（环境/范围）| **二级分类**（业务场景）| **标签格式**
---------------------|---------------------|-------------
内部API | 测试API | （测试API）
内部API | 管理端API | （内部API-管理端）
内部API | 服务间调用（gRPC） | （内部API-服务间调用）
内部API | 内网专用 | （内部API）
运营端 | 运营后台 | （运营端）
运营端 | 运营管理 | （运营端-管理）
ToB（面向企业） | 管理端 | （ToB-管理端）
ToB（面向企业） | 开放平台 | （ToB-开放API）
ToB（面向企业） | 企业内部 | （ToB-内部）
ToC（面向消费者） | 用户端 | （ToC）
ToC（面向消费者） | 公开API | （ToC-公开）
监控/运维 | 健康检查 | （监控API）

### 识别规则

| 分类 | 路径特征 | 关键词 | 示例 |
|------|----------|--------|------|
| **测试API** | `/test/`, `/mock/`, `/debug/`, `/sandbox/` | test, mock, stub, debug, sandbox, dev, beta, staging | `POST /test/api/login` |
| **内部API** | `/internal/`, `/inner/`, `/private/`, `/local/` | internal, inner, private, local | `POST /internal/sync/user` |
| **内部API-服务间调用** | http_method=RPC | gRPC 方法，非 HTTP 入口 | `RPC /userService/getUserInfo` |
| **管理端API** | `/admin/`, `/manage/`, `/backend/`, `/system/` | admin, manage, backend, system | `DELETE /admin/user/:id` |
| **运营端API** | `/operate/`, `/operation/`, `/ops/` | operate, operation, ops | `GET /operate/orders` |
| **ToB-管理端** | `/admin/`, `/manage/` + 企业相关 | admin, enterprise, org, company | `POST /admin/enterprise/create` |
| **ToB-开放API** | `/open/`, `/partner/`, `/api/v1/partner/` | open, partner, external | `GET /open/api/orders` |
| **ToC-用户端** | `/user/`, `/customer/`, `/member/` | user, customer, member, profile | `GET /user/info` |
| **ToC-公开** | `/public/`, 无认证要求 | public, common, guest | `GET /public/announcement` |
| **监控API** | `/health/`, `/metrics/`, `/ping/` | health, ping, metrics, monitor, status | `GET /health/check` |

### api_type 字段标准定义

> **重要**：api_type 是数组字段，一个 API 可有多个类型（如 `["tob","admin"]`）。在数据库中以 JSON 数组字符串存储（TEXT 类型）。

| api_type 值 | 含义 | 对应标签 | 识别优先级 |
|-------------|------|----------|------------|
| `inner` | 内部接口 | （内部API）、（内部API-管理端）、（内部API-服务间调用） | 1 - 最高 |
| `operate` | 运营端接口 | （运营端）、（运营端-管理） | 2 |
| `admin` | 管理员接口 | （管理端）、（ToB-管理端） | 3 |
| `tob` | 面向企业 | （ToB-开放API）、（ToB-内部）、（ToB-管理端） | 4 |
| `toc` | 面向消费者 | （ToC）、（ToC-公开） | 5 |
| `test` | 测试接口 | （测试API） | 6 |
| `unclassified` | 未分类（已分析但无法归类） | 无特征标签 | 7 - 最低 |

**从标签推导 api_type 数组**：
- 含"内部API" → 必须包含 `inner`
- 含"运营端" → 必须包含 `operate`
- 含"管理端"且非内部/运营 → 包含 `admin`
- 含"测试API" → 必须包含 `test`
- 含"ToB" → 包含 `tob`
- 含"ToC" → 包含 `toc`

**组合示例**：
- `（内部API-管理端）` → `["inner", "admin"]`
- `（ToB-管理端）` → `["tob", "admin"]`
- `（内部API）` → `["inner"]`
- `（ToC）` → `["toc"]`
- `（测试API）` → `["test"]`
- 无特征 → `["unclassified"]`（已分析但无法归类，**禁止输出 null**）

**特殊值说明**：

> **监控/健康检查接口**（标签为 `监控API`）的 api_type 应为 `["unclassified"]`，不要使用 `'monitor'` 等非法值，也不要输出 null。
> api_type 的合法值仅为 `inner`、`operate`、`admin`、`tob`、`toc`、`test`、`unclassified`（见 VALID_API_TYPES 定义）。
> `unclassified` 表示已分析但无法归类的接口，与 null（未分析）语义不同。unclassified 接口会被审计跳过，等同于 inner/operate/admin/test。

**互斥规则**：
- `inner` 和 `toc` 通常不共存（内部接口不面向消费者）
- `inner` 和 `tob` 可以共存（内部 ToB 接口）
- `operate` 和 `admin` 可以共存

### 描述输出格式

```
{功能描述}（{分类标签}）
```

**示例**：
- `删除API Key（内部API-管理端）`
- `用户登录（ToC）`
- `企业订单创建（ToB-管理端）`
- `商品列表查询（ToC-公开）`
- `文件上传（ToC）`
- `健康检查（监控API）`
- `测试接口（测试API）`

### 组合规则

1. **单标签**：最常见场景，如 `（ToC）`、`（内部API）`
2. **双标签组合**：当同时满足两个分类时，使用 `-` 连接
   - `（内部API-管理端）`：内部管理接口
   - `（ToB-管理端）`：ToB 产品的管理后台接口
3. **优先级**：环境分类 > 业务分类
   - 优先标注：测试API > 内部API > ToB/ToC > 监控API
   - 例如：内部管理接口 → `（内部API-管理端）` 而非 `（管理端-内部API）`

---

## 八、注意事项

1. **最低优先级限制**：降级后最低为 P3，不会出现负级
2. **叠加降级**：同时满足多个降级条件时，降级幅度叠加（如内部+管理员 = -2 级）
3. **测试接口例外**：若测试接口暴露在公网且无认证，不降级（仍为 P0）
4. **管理员接口注意**：虽然降级，但仍需关注权限提升和越权访问风险
5. **标签一致性**：描述标签必须与优先级判定中的类型判断保持一致
6. **敏感语义关键词强制升级（覆盖降级规则）**：路径或方法名含以下关键词时，**无论接口类型如何，强制升级至 P0**，不允许因 admin/inner/test 降级覆盖：

| 关键词 | 风险原因 | 示例 |
|--------|----------|------|
| `backdoor`, `back_door`, `back-door` | 后门接口，直接高危 | `/api/backdoor/archive` |
| `bypass` | 认证/权限绕过 | `/auth/bypass` |
| `rce`, `exec`, `execute`, `command`, `shell`, `runtime`, `subprocess` | 远程代码执行 | `/admin/exec/command` |
| `deserializ`, `readobject`, `unmarshal`, `pickle`, `yaml.load` | 反序列化 RCE | `/internal/deserialize` |
| `debug` + 写操作（POST/PUT/DELETE） | 调试接口带写权限 | `POST /debug/setConfig` |

> **判断依据**：匹配路径中任意段（case-insensitive）或 api_method 名称。纯 GET 的 debug 查询接口保持降级，带写操作的 debug 接口强制 P0。
