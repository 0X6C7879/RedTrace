# IDOR

## 0. 前置判断：认证检查（强制门禁）

**触发条件**: 开始审计任何资源访问代码（必须首先执行）

**强制动作**: 
1. 检查接口认证状态
2. **无认证场景必须切换到 BrokenAccessControl（未授权子类型） 流程，禁止继续本文档**

**认证状态判定表**:

| 认证状态 | 判定 | 后续动作 |
|---------|------|---------|
| 无中间件保护 + NoAuth/public标记 + 无认证中间件 | **无认证** | 立即结束IDOR审计，切换到 BrokenAccessControl（未授权子类型） 流程 |
| 有认证中间件（Auth/JWT/Session） | **有认证** | 继续本文档流程 |
| 路由含 /public/、/open/、/anon/ | **疑似无认证** | 进一步确认后切换 |

**无认证识别信号**（满足任一即判定为无认证）:
- 路由含 `NoAuth`/`public`/`skipAuth` 标记
- 路由组未应用认证中间件
- 路由路径含 /public/、/open/、/anon/ 关键词

**说明**: IDOR 的定义是"有认证但能越权访问他人资源"，无认证场景属于 BrokenAccessControl（未授权子类型）（认证缺失），修复优先级不同。

**质量门禁**: 未完成认证检查，禁止进入 Step 2.0

---

## 1. 结论判断标准

**前提条件**：接口必须有认证机制。无认证场景应定性为 BrokenAccessControl（未授权子类型），不使用本判断标准。

**攻击者视角假设**（强制执行）：

| 假设项 | 说明 |
|--------|------|
| 攻击者身份 | 外部用户，非内部员工 |
| 攻击者权限 | 普通用户权限（普通用户、普通商家、普通广告主） |
| 攻击者不具备 | 管理员权限、HR角色、运营角色、其他特权角色 |
| 漏洞判定逻辑 | 若仅"管理员/特权角色可越权"则不构成漏洞，因为攻击者无法获得该身份 |

**典型案例**：
- 漏洞：普通商家A可查看普通商家B的订单（攻击者作为普通商家即可利用）
- 非漏洞：仅HR角色可查看所有员工信息（攻击者无法获得HR角色，不构成可利用的越权）

| 结论 | 定义 | 认证前提 | 判定条件 |
|------|------|---------|----------|
| **漏洞** | 已认证用户可通过 HTTP/gRPC 入口访问他人资源，无有效权限校验 | 必须有认证 | 1. 存在资源访问操作; 2. 资源标识符用户可控; 3. 数据流可追踪到 HTTP/gRPC 入口点; 4. 无所有权/权限校验; 5. 资源标识符**可预测或可遍历**（自增整数/雪花ID/规则拼接编号等） |
| **风险-A** | 存在资源访问但无 HTTP/gRPC 入口可达（内部调用） | 必须有认证 | 1. 存在资源访问操作; 2. 数据流不可追踪到外部入口; 3. 非测试/非配置代码 |
| **风险-B** | 资源访问有 HTTP 入口可达，但权限校验不充分；或标识符不可预测导致利用难度高 | 必须有认证 | 1. 存在资源访问操作; 2. HTTP 入口可达; 3a. 有弱权限校验（如仅检查登录状态、可绕过的校验、nil panic 风险导致校验绕过）; **或 3b. 无权限校验但资源标识符不可预测（UUID v4/强随机），单条查询场景** |
| **安全** | 无危险写法，或危险写法有充分的有效防护 | - | 1. 有所有权校验，或; 2. 有中间件校验，或; 3. 查询时过滤用户数据，或; 4. 非线上环境 |

---

## 2. 漏洞风险的研判思路

### 2.0 公开数据快速判定

**触发条件**: 开始审计任何资源访问代码

**必做动作**:
1. 识别接口操作的数据类型
2. 对照公开数据类型表判定

**公开数据类型表**:

| 数据类型 | 识别特征 | 判定 |
|---------|---------|------|
| 系统配置 | ABTest配置、功能开关、模块配置 | 安全 |
| 公开内容 | 网站公告、帮助文档、字典数据 | 安全 |
| 非个人数据 | 商品列表、公开统计数据 | 安全 |
| 全局共享配置 | 三方数据源配置、公共参数配置 | 安全 |
| 公开对象存储 | BlobStore/S3/OSS CDN分发的公开资源（图片/视频/静态文件） | 安全 |
| 系统字典数据 | Dict/Dictionary/Option表 | 安全 |
| 商品类目数据 | Product/Goods/Category/Item | 安全 |
| 全局配置表 | 表名含`config`、`setting`，无userId字段 | 安全 |
| 三方数据源配置 | 表名含`exchange`、`original`，无归属字段 | 安全 |

**结束门槛**:
- 确认是公开数据 → 安全（直接结束审计，禁止继续研判）
- 确认非公开数据 → 进入 Step 2.05

**禁止**:
- 假设接口非公开数据就跳过本步骤

---

### 2.05 资源敏感度分类

**触发条件**: Step 2.0 确认非公开数据

**必做动作**:
1. 识别资源类型（结构体名、表名、接口路径）
2. 根据资源类型推断敏感度级别
3. 确定该敏感度级别的鉴权要求

**四级敏感度分类表**：

| 级别 | 定义 | 资源类型示例 | 鉴权要求 |
|------|------|-------------|----------|
| **L1 公开** | 任何人可访问 | 公告、帮助文档、商品列表、首页配置 | 无需鉴权 |
| **L2 内部** | 登录用户可访问 | 企业内部文档、组织架构、部门信息 | 登录鉴权 |
| **L3 受限** | 特定权限/关系可访问 | 好友列表、团队成员、参与的项目 | 权限/关系鉴权 |
| **L4 敏感** | 仅所有者可访问 | 订单、支付记录、私信、个人设置 | 所有权鉴权 |

**资源类型推断表**：

| 资源类型关键词 | 推断级别 | 典型实体 |
|---------------|---------|---------|
| Order, Payment, Transaction, Invoice | L4 敏感 | 订单、支付、交易、发票 |
| Message, Chat, Conversation, Notification | L4 敏感 | 消息、聊天、通知 |
| UserProfile, Settings, Credential, APIKey | L4 敏感 | 个人设置、凭证、密钥 |
| Friend, Contact, Relation | L3 受限 | 好友、联系人 |
| Team, Project, Workspace, Member | L3 受限 | 团队、项目、成员 |
| Document, Wiki, Article, Knowledge | L2 内部 | 文档、知识库 |
| Announcement, Notice, Help, FAQ | L1 公开 | 公告、帮助 |
| Product, Goods, Category, Item | L1 公开 | 商品、类目 |
| Config, Dictionary, Dict, Option | L1 公开 | 配置、字典 |

**结束门槛**:
- L1 公开 → 安全（直接结束审计）
- L2/L3/L4 → 进入 Step 2.1

**鉴权要求违反规则**：

| 实际鉴权 | 要求鉴权 | 判定 |
|---------|---------|------|
| 无 | L4(所有权) | 漏洞 |
| 仅登录 | L4(所有权) | 漏洞 |
| 无 | L3(权限) | 漏洞 |
| 仅登录 | L3(权限) | 风险-B |
| 无 | L2(登录) | 漏洞 |
| 仅登录 | L2(登录) | 安全 |

**禁止**:
- 假设所有资源都需要所有权鉴权（需先判断敏感度）
- 仅凭表名/结构体名就确定级别（需结合接口功能）

---

### 2.1 资源识别

**触发条件**: Step 2.05 确认非 L1 数据

**必做动作**:
1. 搜索资源访问方法（db.First/db.Find/db.Where 等）
2. 确认是否涉及用户可控资源的访问

**结束门槛**:
- 无资源访问操作 → 安全（直接结束审计）
- 有资源访问操作 → 进入 Step 2.2

**禁止**:
- 仅看方法名判断，必须确认数据流

---

### 2.2 参数来源检查

**触发条件**: Step 2.1 确认有资源访问操作

**必做动作**:
1. 追踪资源 ID 参数来源
2. 判断参数是否来自用户输入

**结束门槛**:
- 参数来自内部/配置 → 安全（直接结束审计）
- 参数来自 c.Param/c.Query/c.PostForm/req.URL.Query → 进入 Step 2.3

**禁止**:
- 假设参数名是 id 就用户可控

---

### 2.3 数据流透传分析

**触发条件**: Step 2.2 确认参数用户可控

**必做动作**:
1. 追踪身份 ID 是否透传给下游
2. 检查资源 ID 是否也透传

**结束门槛**:
- 身份 ID 与资源 ID 一起透传，且下游未给出代码 → 安全（下游有身份 ID 可做权限判断）
- 仅资源 ID 透传（无身份 ID），且当前项目无下游代码 → 漏洞（下游无法判断所有权）
- 仅身份 ID 透传，或上游未校验 → 进入 Step 2.3.5

**禁止**:
- 仅资源 ID 透传时假设下游会自动校验
- 未确认身份 ID 是否一起透传就假设下游校验

---

### 2.3.5 参数用途追踪

**触发条件**: Step 2.3 需要继续研判（参数用户可控，且非透传场景）

**必做动作**:
1. 追踪可控参数在后续代码中的实际使用方式
2. 判断可控参数的值是否被用于权限判断
3. 区分"参数被接收"与"参数值被用于权限校验"

**结束门槛**:
- 参数值被直接用于资源查询且未经身份校验 → 继续 Step 2.4
- 参数值被服务端获取的其他值替换后再用于权限判断 → 安全
- 参数被传递给方法但方法内部使用了可信来源的身份 ID → 安全

**禁止**:
- 仅因函数签名包含某参数就假设该参数的值被用于权限判断
- 不追踪参数的实际流向就做出越权判定

---

### 2.4 权限校验检查

**触发条件**: Step 2.3 或 Step 2.3.5 需要继续研判

**必做动作**:
1. 检查是否有所有权校验代码
2. 检查是否有权限中间件
3. 检查查询时是否过滤用户数据

**结束门槛**:
- 有有效所有权校验/权限中间件/数据过滤 → 安全（直接结束审计）
- 白名单校验特定用户可访问的资源范围 → 安全（直接结束审计）
- 白名单仅是功能开关（不区分用户） → 不构成 IDOR 防护，进入 Step 2.5
- 无校验或校验不足 → 进入 Step 2.5

**白名单判定逻辑**:
- 白名单限制**哪些用户可以访问哪些资源** → 安全（等效权限校验）
- 白名单仅控制**功能是否对所有用户启用/关闭** → 不构成 IDOR 防护，继续研判

**禁止**:
- 看到有中间件就认为安全（可能是仅检查登录）
- 将全局功能开关误判为白名单防护

### 2.4.2 权限校验机制有效性验证

**触发条件**: Step 2.4 发现中间件/拦截器等校验机制

| 校验类型 | 验证方法 | 安全判定 | 不安全判定 |
|---------|---------|---------|-----------|
| 中间件 | 确认路由组已 Apply + 读取中间件实现 | 校验所有权（userID==ownerID） | 仅检查登录 |
| 拦截器 | 确认覆盖当前路由 + 读取注入逻辑 | 参数确实由拦截器注入 | 未覆盖当前路由 / 来源不明 |
| 配置开关 | 检查默认值 | 开关默认开启 | `Kconf.Bool("xxx", false)` → 风险-B |

```bash
grep -rn 'func.*Middleware\|\.Use(' --include="*.go"        # 中间件注册
grep -rn 'c\.Set\|c\.Get' --include="*.go"                   # Context 注入
```

### 2.4.3 相似接口鉴权交叉参照（补充证据步骤）

**触发条件**: Step 2.4 已完成当前接口权限检查

**定位**: 本步骤是**补充证据步骤**，不是强制门禁。无相似接口时跳过，不影响主流程。

**必做动作**:
1. 识别同 handler 文件/路由组中访问相同资源类型的其他接口
2. 比较这些接口与当前接口的鉴权模式
3. 将差异作为补充证据记录

**结论影响**:

| 相似接口 | 当前接口 | 影响 |
|---------|---------|------|
| 有所有权校验 | 无所有权校验 | 加强漏洞判定 |
| 有鉴权中间件 | 无鉴权中间件 | 确认认证缺失 |
| 均无鉴权 | 无鉴权 | 中性 |
| 未找到相似接口 | 任意 | 无影响，继续正常流程 |

**典型案例**:
```go
// 同文件中查询接口有所有权校验
func (h *OrderHandler) GetOrder(c *gin.Context) {
    userID := c.GetInt64("userID")
    orderID, _ := strconv.ParseInt(c.Param("id"), 10, 64)
    var order Order
    db.Where("id = ? AND user_id = ?", orderID, userID).First(&order)
}

// 修改接口无校验 → 漏洞证据增强
func (h *OrderHandler) UpdateOrder(c *gin.Context) {
    orderID, _ := strconv.ParseInt(c.Param("id"), 10, 64)
    var order Order
    db.Where("id = ?", orderID).First(&order)  // 漏洞
}
```

**禁止**:
- 穷举扫描所有接口（最多查看 3-5 个相似接口）
- 将相似接口的鉴权视为当前接口已鉴权的充分证据

---

### 2.4.5 批量操作鉴权覆盖性检查

**触发条件**: 接口同时存在单个和批量操作模式

**必做动作**:
1. 识别批量操作入口（参数类型为 `[]uint`/`[]string`/`[]int64` 等）
2. 检查鉴权逻辑是否覆盖批量入口

**结束门槛**:
- 批量入口有独立鉴权逻辑 → 安全
- 批量入口无鉴权但单个入口有 → 漏洞（批量操作绕过鉴权）
- 单个和批量均无鉴权 → 继续 Step 2.5

**典型模式**:
```go
func DeleteNovel(c *gin.Context) {
    if !novelAuth.Check(getUserID(c), c.Param("novelId")) {  // 仅单个有鉴权
        c.JSON(403, gin.H{"error": "forbidden"})
        return
    }
    db.Delete(&Novel{}, c.Param("novelId"))
}

func DeleteNovelsBatch(c *gin.Context) {
    var req struct{ NovelIDs []uint `json:"novel_ids"` }
    c.BindJSON(&req)
    db.Delete(&Novel{}, req.NovelIDs)  // 漏洞：批量入口无鉴权
}
```

**禁止**:
- 假设单个鉴权自动覆盖批量模式
- 忽略批量操作的独立入口

---

### 2.5 HTTP 入口可达性分析

**触发条件**: Step 2.4 确认无有效权限校验

**必做动作**:
1. 追踪数据流到 HTTP/gRPC 入口点
2. 确认是否存在外部入口

**结束门槛**:
- 无 HTTP/gRPC 入口 → 风险-A
- 有 HTTP/gRPC 入口 → 进入 Step 2.6

**禁止**:
- 假设所有方法都有 HTTP 入口

---

### 2.6 最终判定

**触发条件**: Step 2.5 确认有 HTTP 入口

**必做动作**: 综合前面所有检查结果，对照 Section 1 判定标准表

**结束门槛**:
- 无任何校验 → 漏洞
- 仅检查登录状态 → 漏洞
- 指针类型可能 nil panic → 风险-B

**禁止**:
- 在前面步骤未完成时就跳到最终判定

---

### 2.7 多租户场景检查

**触发条件**: Step 2.6 确认为漏洞/风险-B

**核心判定逻辑**：

| 隔离模式 | WHERE 条件 | 判定 |
|---------|-----------|------|
| 双重隔离 | `tenant_id = ? AND user_id = ?` | 安全 |
| 仅租户隔离 | `tenant_id = ?` | 安全（租户内资源共享） |
| 仅用户隔离 | `user_id = ?` | **漏洞（跨租户风险）** |
| 无隔离 | `id = ?` | **漏洞（双重越权）** |

**租户级越权升级规则**：跨租户访问风险（缺 `tenant_id` 隔离）→ 风险-B **升级为漏洞**

---

### 2.8 利用难度评估

**触发条件**: Step 2.6 确认为漏洞/风险-B

**ID 类型分类表**：

| ID 类型 | 可预测性 | 风险等级 |
|---------|----------|----------|
| 自增整数 | 高 | 高 |
| 雪花算法 | 中 | 中 |
| UUID v4 | 低 | 低 |
| Hash ID | 中 | 中-低 |
| BlobStore key（S3/OSS 对象键） | 不可遍历 | 不报告（降级） |

**无注解时的类型推断（强制执行）**：

| 推断场景 | 结论 | 处理方式 |
|---------|------|---------|
| uint/int/int64 + 字段名含 ID/Id + 是主键 | 推断为自增，按高风险 | 搜索 `gorm:"autoIncrement"` 或 DDL |
| string + 字段名含 Key/Code/No/Token/SN | 需进一步判断 | 短字符串（≤16位）→ 中风险；长随机 → 低风险 |
| string + 字段名为 ID/Id | 不可假设 UUID | 搜索赋值语句 |

**非 id 命名的资源标识符**：

| 参数特征 | 可预测性评估 |
|---------|-------------|
| 业务 key（courseKey/productKey/orderNo） | UUID 生成 → 低；规则拼接 → 中；纯序号 → 高 |
| 编号（taskNo/serialNo/batchNo） | 含时间戳 → 中；纯递增 → 高 |
| Token（shareToken/accessKey） | `crypto/rand` hex → 低；MD5(id) → 中 |

**关键降级/升级规则**：

| 条件 | 原结论 | 调整后 |
|------|--------|--------|
| UUID/强随机 ID + 单条查询 | 漏洞 | 风险-B |
| 自增 ID + 批量接口 | 漏洞 | 漏洞（严重） |
| 跨租户访问 | 风险-B | 漏洞（升级） |

---

### 2.8.4 资源归属判断（强制门禁）

**触发条件**: Step 2.6 确认为漏洞或风险-B

**判定规则**:

| 资源ID类型 | 来源 | 判定 |
|-----------|------|------|
| 身份标识符（userId/accountId） | 可信来源（中间件/Context注入） | 安全（自身操作） |
| 身份标识符 | 不可信来源 | 继续研判 |
| 业务资源标识符（orderId/docId） | 任意 | 继续研判（需查归属） |

**可信来源**: `c.GetString("userId")`（Gin中间件）、`ctx.Value(userIdKey)`（gRPC拦截器）、JWT 解析的用户 ID
**不可信来源**: `c.Param("userId")`、`c.Query("userId")`、`c.PostForm("userId")`

---

### 2.8.5 攻击价值评估（强制执行）

**触发条件**: Step 2.6 确认为漏洞或风险-B

#### A. 返回类型降级检查

| 返回类型 | severity | 是否可升级 |
|---------|----------|----------|
| bool | **low** | ❌ 禁止升级 |
| int/int64（统计） | **low** | ❌ 禁止升级 |
| 已公开数据 | **不报告** | - |
| 部分 PII（昵称/头像） | 原等级-1 | - |

#### B. 读写操作调整

| 操作类型 | severity调整 |
|---------|-------------|
| 删除（DELETE） | 基础等级 **+1**（最高critical） |
| 修改（PUT/PATCH）金额/权限字段 | 升级为 **critical** |
| 批量操作 | 基础等级 **+1** |

#### C. ID可预测性最终检查

| ID类型 | 单条查询调整 |
|--------|-------------|
| 自增整数 | 维持原等级 |
| 雪花ID | 可降1级 |
| UUID v4 | **强制 risk-b** |
| Hash ID（≥32位） | **强制 risk-b** |

> **严重程度评级**：参见 references/common/severity-rating.md「IDOR 专项快速判定表」。

---

### 2.9 降级条件表

**通用降级条件**：非线上环境→安全，无 HTTP 入口→风险-A

| 条件 | 原结论 | 调整后 |
|------|--------|--------|
| 所有权校验 / 中间件 / 数据过滤 | 漏洞 | 安全 |
| 仅检查登录状态 | 漏洞 | 漏洞（不降级） |
| 指针类型可能 nil | 安全 | 风险-B（nil panic 绕过风险） |
| UUID/强随机 ID + 单条查询 | 漏洞 | 风险-B |
| 跨租户访问风险 | 风险-B | 漏洞（升级） |

### 2.10 关键识别信号

| 信号类型 | 身份 ID | 资源 ID |
|---------|---------|---------|
| 常见字段 | userId, sellerId, merchantId, accountId, **tenantId** | orderId, photoId, assetId, campaignId, documentId |
| 研判重点 | 来源是否可信 | 是否做归属校验 |

### 2.11 参数源信任分类

| 入口类型 | 可信来源 | 不可信来源 |
|---------|---------|-----------|
| **gRPC 接口** | `ctx.Value("userId")`（拦截器注入） | - |
| **HTTP 接口** | 中间件注入的 `c.Get("userId")` | `c.Param()`, `c.Query()` |

---

### 2.12 总结判定表

| 检查项 | 结论 | 证据 |
|--------|------|------|
| 公开数据？ | 安全 | 公告/配置/字典等 |
| L4 敏感资源所有权校验？ | 漏洞/安全 | Order/Payment + Where("user_id = ?") |
| L3 受限资源权限校验？ | 漏洞/安全 | Friend/Team + 关系校验 |
| L2 内部资源仅登录？ | 安全/风险-B | AuthMiddleware |
| 参数不可控？ | 安全 | 来自内部/配置 |
| 身份 ID 来源可信？ | 安全/继续 | 中间件注入/Context |
| 所有权校验/中间件/数据过滤？ | 安全 | userID 检查/db.Where |
| 相似接口鉴权模式一致？ | 漏洞/安全 | 查询有校验+修改无 → 证据 |
| 多租户隔离完整？ | 漏洞/安全 | WHERE 含 tenant_id？ |
| ID 类型自增 + 批量查询？ | 漏洞（严重） | db.Find(&resources, ids) |
| 无 HTTP 入口？ | 风险-A | 内部方法 |
| 仅检查登录 / 无校验？ | 漏洞 | 仅检查 token / 直接返回 |

---

## 3. 常见漏洞/风险场景

### 3.1 漏洞类型

#### 场景1：直接使用用户输入（多场景合并）

```go
// Gin
func GetUser(c *gin.Context) {
    var user User
    db.First(&user, c.Param("id"))  // 漏洞
    c.JSON(200, user)
}

// 嵌套资源未校验
func GetUserOrder(c *gin.Context) {
    var order Order
    db.First(&order, c.Param("orderId"))  // 漏洞：未校验 order 所属
    c.JSON(200, order)
}

// 查询参数
func GetOrder(c *gin.Context) {
    var order Order
    db.First(&order, c.Query("id"))  // 漏洞
    c.JSON(200, order)
}
```

#### 场景2：跨租户访问

```go
func GetOrder(c *gin.Context) {
    var order Order
    db.Where("id = ? AND user_id = ?", c.Param("id"), c.Query("userId")).First(&order)
    // 漏洞：跨租户风险
}
```

#### 场景3：批量查询放大

```go
func GetOrdersBatch(c *gin.Context) {
    var ids []uint
    c.BindJSON(&ids)
    var orders []Order
    db.Find(&orders, ids)  // 漏洞（严重）
}
```

#### 场景4：业务状态二次操作越权

```go
func ProcessApply(c *gin.Context) {
    var apply AuthApply
    db.First(&apply, "apply_no = ?", c.PostForm("apply_no"))
    db.Model(&apply).Updates(map[string]interface{}{
        "status": c.PostForm("status"),  // 漏洞：无状态锁定校验
    })
}
```

#### 场景5：共享密钥身份伪造（OpenAPI）

```go
func GetAnchorContent(c *gin.Context) {
    secretKey := config.GetString("openapi.secret")  // 共享密钥
    userID := c.PostForm("user_id")
    c.JSON(200, anchorService.GetContent(userID))  // 漏洞：身份参数可伪造
}
```

#### 场景6：资源ID枚举全站越权

```go
// 攻击链：列表接口枚举 appID → 更新接口越权
func ListProducts(c *gin.Context) {
    var products []Product
    db.Find(&products)  // 泄露 appID
    c.JSON(200, products)
}

func UpdateResource(c *gin.Context) {
    var resource Resource
    db.First(&resource, c.Query("resource_id"))
    resource.Content = c.PostForm("content")
    db.Save(&resource)  // 漏洞
}
```

#### 场景7：会话资源多用户越权

```go
func GetConversation(c *gin.Context) {
    if !userAgentService.Exists(getUserID(c), c.Param("conversation_id")) {
        c.JSON(403, gin.H{"error": "forbidden"})
        return
    }
    var conversation Conversation
    db.First(&conversation, c.Param("conversation_id"))  // 漏洞
}
```

#### 场景8：嵌套资源父资源校验缺失

```go
func GetUserOrder(c *gin.Context) {
    var order Order
    db.First(&order, c.Param("orderId"))  // 漏洞：userId 未参与校验
    // 正确：db.Where("id = ? AND user_id = ?", c.Param("orderId"), c.Param("userId")).First(&order)
}
```

#### 场景9：多租户ID越权参数

```go
func ProcessAuthApply(c *gin.Context) {
    var apply AuthApply
    db.First(&apply, "apply_no = ?", c.PostForm("apply_no"))
    apply.Status = c.PostForm("status")
    db.Save(&apply)  // 漏洞：缺少租户归属校验
}
```

#### 场景10：权限标识字段篡改

```go
func UpdateUser(c *gin.Context) {
    var req struct {
        UserID  uint `json:"user_id"`
        IsAdmin bool `json:"is_admin"`
    }
    c.BindJSON(&req)
    var user User
    db.First(&user, req.UserID)
    user.IsAdmin = req.IsAdmin  // 漏洞：权限字段来源不可信
    db.Save(&user)
}
```

#### 场景11：相似接口鉴权差异暴露越权

```go
// 同文件中查询接口有所有权校验
func (h *OrderHandler) GetOrder(c *gin.Context) {
    userID := c.GetInt64("userID")
    orderID, _ := strconv.ParseInt(c.Param("id"), 10, 64)
    var order Order
    db.Where("id = ? AND user_id = ?", orderID, userID).First(&order)
}

// 修改接口无校验
func (h *OrderHandler) UpdateOrder(c *gin.Context) {
    orderID, _ := strconv.ParseInt(c.Param("id"), 10, 64)
    var order Order
    db.Where("id = ?", orderID).First(&order)  // 漏洞
    c.ShouldBindJSON(&order)
    db.Save(&order)
}
```

### 3.2 风险-B 类型

#### 场景1：指针 nil 比较可能 panic

```go
var order Order
db.First(&order, c.Param("id"))
if *order.UserID != getUserID(c) {  // order.UserID 为 nil → panic
    c.JSON(403, gin.H{"error": "forbidden"})
    return
}
// 风险-B：应先检查 nil 或使用值类型
```

#### 场景2：中间件校验不完整

```go
func AuthMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        token := c.GetHeader("Authorization")
        if token == "" {
            c.AbortWithStatus(401)
            return
        }
        // 风险-B：仅验证 token，未校验资源所有权
        c.Next()
    }
}
```

#### 场景3：gRPC 参数由拦截器注入

```go
func GetUser(ctx context.Context, req *Request) (*User, error) {
    userId := ctx.Value("userId").(string)
    return userRepo.FindById(userId)
}
```

**结论**: 需确认 userId 来源 → 拦截器注入且不可控 → 安全；来源不明 → 风险-B

---

## 4. 常见防御模式

| 防御类型 | 代码示例 |
|---------|---------|
| 所有权校验 | `if userID != resource.UserID { c.JSON(403, ...); return }` |
| 数据过滤 | `db.Where("user_id = ?", userID).First(&order)` |
| 中间件 | `OwnershipMiddleware()` |
| GORM Scopes | `db.Scopes(UserScope(userID)).First(&order)` |
| 多租户隔离 | `Where("tenant_id = ? AND user_id = ?", tenantID, userID)` |
| 关系鉴权 | `if !isFriend(authID, targetID) { return 403 }` |
| 白名单校验 | `if !whiteList[userID] { c.AbortWithStatus(403); return }` |

**UUID ID 增加遍历难度**:
```go
type Order struct {
    ID uuid.UUID `gorm:"type:uuid;primary_key;default:uuid_generate_v4()"`
}

// 配合权限校验
func GetOrder(c *gin.Context) {
    userID := getUserID(c)
    var order Order
    db.Where("id = ? AND user_id = ?", c.Param("id"), userID).First(&order)  // 更安全
}
```

**GORM Scopes（可复用查询过滤）**:
```go
func UserScope(userID uint) func(db *gorm.DB) *gorm.DB {
    return func(db *gorm.DB) *gorm.DB {
        return db.Where("user_id = ?", userID)
    }
}

db.Scopes(UserScope(userID)).First(&order)  // 安全
```

**白名单校验（等效权限校验）**:
```go
func GetCreative(c *gin.Context) {
    userID := getUserID(c)
    if !whiteList[userID] {
        c.JSON(403, gin.H{"error": "不在白名单内"})
        return
    }
    var creative Creative
    db.First(&creative, c.Param("id"))  // 安全
}
```

---

## 5. 检索技巧

### 5.1 检测命令

```bash
# 查找资源访问
grep -rn 'db\.First\|db\.Find\|db\.Where' --include="*.go"

# 查找中间件
grep -rn 'func.*Middleware\|\.Use(' --include="*.go"

# 查找所有权校验
grep -rn 'userID.*==\|currentUserID.*==' --include="*.go"
```

---

## 6. 常见误判场景

### 陷阱1：仅检查登录/有中间件不等于安全

**错误**：检查了 token/登录就安全
**正确**：任何登录用户可访问任意资源 → 漏洞

### 陷阱2：嵌套资源未校验子资源

**错误**：校验了 `userId` 就够了
**正确**：需 `WHERE id = ? AND user_id = ?` 确保子资源属于该用户

### 陷阱3：假设前端合法

**错误**：假设前端只传合法 ID
**正确**：参数可篡改 → `db.First(&resource, id)` → 漏洞

### 陷阱4：指针类型 nil panic

**错误**：有比较就安全
**正确**：`*order.UserID` 若为 nil → panic → 风险-B

### 陷阱5：Context 中的用户 ID 可信

**错误**：`c.Get("userID")` 就不可控
**正确**：需确认中间件注入逻辑是否安全

### 陷阱6：gRPC 由拦截器注入

**错误**：参数名是 userId 就用户可控
**正确**：gRPC 拦截器注入的 userId 可能不可控 → 需确认

### 陷阱7：混淆身份篡改与资源越权

**错误**：报告"用户可以传入任意 userId 造成越权"
**正确**：需先确认 userId 是否可信
- gRPC 拦截器注入的 userId → 不可篡改
- HTTP 路径/查询参数的 userId → 需研判

本文档聚焦于 **资源 ID 越权**（IDOR）。

### 陷阱8：批量操作鉴权覆盖性假设

**错误**：单个操作有鉴权逻辑，批量操作自动覆盖
**正确**：需检查鉴权逻辑是否同时覆盖单个和批量操作入口

### 陷阱9：父资源ID冗余假设

**错误**：路由中有父资源ID就够了
**正确**：父资源ID必须参与资源归属校验

### 陷阱10：孤立接口鉴权假设

**错误**：仅检查当前接口，忽略同 handler 文件中相似接口的鉴权模式
**正确**：相似接口的鉴权模式可辅助判定是否缺少鉴权

---

## 7. 误报排除规则（IDOR 特有）

> 通用误报排除：[../common/false-positive-filtering.md](../common/false-positive-filtering.md)

| 场景 | 判定 | 原因 |
|------|------|------|
| userId/sellerId 来自拦截器 | 不报告 | 用户无法篡改 |
| 资源 ID + 身份 ID 一起透传给下游 | 不报告 | 下游可做权限判断 |
| 仅资源 ID 透传（无身份 ID）且无下游代码 | 漏洞 | 下游无法判断所有权 |
| 公开数据接口（公告/配置/字典） | 不报告 | 公开数据 |
| S3 同 Bucket 内 key 路径操作 | 不报告 | AK/SK 控制访问权限 |
| 公开对象存储（BlobStore/S3/OSS）CDN 公开分发，Bucket 名不可枚举 | 不报告 | 存储设计为公开访问 |
| 内部服务调用（无 HTTP 入口） | 不报告 | 无外部入口可达 |

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增用户可控 ID 访问 | 检查参数来源、所有权校验 |
| 新增 | 新增资源访问方法 | 追踪数据流、HTTP 入口 |
| 新增 | 新增批量操作接口 | 确认鉴权是否覆盖批量模式 |
| 新增 | 新增租户级资源参数 | 确认是否做归属校验 |
| 修改 | 移除所有权校验代码 | 扩大攻击面，引入 IDOR |
| 修改 | 将 findByIdAndUserId 改为 findById | 移除防护 |
| 修改 | 移除状态校验条件 | 二次操作越权 |
| 修改 | 批量接口移除鉴权注解 | 批量操作绕过鉴权 |
| 删除 | 删除所有权校验 if 块 | 移除防护 |
| 删除 | 删除鉴权注解/拦截器 | 移除防护 |
| 删除 | 删除状态校验逻辑 | 二次操作越权 |
| 删除 | 删除父资源 ID 校验 | 嵌套资源越权 |

---

## 9. 质量检查门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] **Section 0 认证检查**已执行，确认接口有认证
- [ ] **Step 2.0 公开数据判定**已完成，确认非L1公开数据
- [ ] **Step 2.05 敏感度分类**已完成，确认非L2或有登录鉴权
- [ ] **Step 2.8 ID可预测性**已评估，UUID已降级
- [ ] **Step 2.8.4 资源归属判断**已执行，确认非自身操作
- [ ] **Step 2.8.5 攻击价值评估**已完成，返回类型已检查
- [ ] **Step 2.4.3 相似接口交叉参照**已执行（补充证据步骤，无相似接口可跳过）
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**

**强制门禁**:
- 无认证接口 **必须** 切换到 BrokenAccessControl（未授权子类型） 流程
- 返回布尔值 **必须** 强制为 low（禁止升级）
- UUID单条查询 **必须** 降级为 risk-b
- 自身操作自身资源 **必须** 判定为安全
- 假设中间件存在就安全 → 必须检查中间件实现逻辑
- 仅资源 ID 透传时假设下游校验 → 需同时透传身份 ID
- 仅看方法名判断安全性 → 必须追踪数据流
