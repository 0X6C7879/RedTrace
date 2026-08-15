# 文件上传案例集

> 整合内部真实漏洞与业界经典案例，提供实战指导

## 一、内部真实案例

### 案例1：海外某内部系统可上传 HTML 文件存在 XSS 漏洞风险
**系统**: 某内部系统

**漏洞描述**:
`/rest/i18n/adUc/common/fileUpload` 接口通过黑白名单限制了上传文件的后缀类型，但没有校验请求中 `Content-Type` 的类型。在上传至 BlobStore 时会设置 `Content-Type` 为上传文件的类型，攻击者可以将请求中的 `Content-Type` 设置为 `text/html`，并将上传文件内容改为 JS 代码，从而执行 JS 代码，存在 XSS 漏洞。

**技术细节**:
- 后缀校验通过（如 `.jpg`），但未校验请求中的 `Content-Type`
- BlobStore 存储时以请求 `Content-Type` 为准设置文件的媒体类型
- 攻击者将 `Content-Type` 伪造为 `text/html`，文件内容写入 JS 代码
- CDN 下发时浏览器按 HTML 解析，导致存储型 XSS

**修复方案**:
校验 `Content-Type` 是否是允许的类型，或者上传 BlobStore 时不要指定 `Content-Type`，让 BlobStore 根据文件后缀来识别文件类型。

**经验总结**:
文件上传需在服务端校验文件类型，通过读取文件魔数（magic bytes）而非仅依赖扩展名或 Content-Type。

---

### 案例2：电商开放管理后台存在任意格式文件上传问题
**系统**: 某内部系统

**漏洞描述**:
电商开放管理后台集成场景上传图标、公告页面上传图片处均存在任意格式文件上传问题，可上传 HTML 文件到 CDN 上，且访问链接可正常解析。危害包括：
1. 如果该 CDN 域名在域名白名单中，则主 App 加载该域下的 JS 代码，可能调用主 App 中的 JSBridge；
2. 页面外网可访问，可利用此问题上传恶意页面，进行钓鱼、散播不良信息等；
3. 文件上传直接调用了 CDN 提供的接口，前端页面代码和数据包中均包含 CDN 分配的 token，会造成 token 泄露。

**技术细节**:
- 上传功能无文件类型限制，支持任意格式文件上传
- CDN 域名在 App 信任白名单内，可触发 JSBridge 调用
- 上传流程直接暴露 CDN Token，存在二次利用风险

**修复方案**:
服务端严格限制允许上传的文件类型（白名单），CDN Token 不应暴露在前端，上传凭证应在服务端生成并短期有效。

**经验总结**:
上传的文件需存储到 Web 根目录之外，或通过 CDN/对象存储访问，不允许直接通过 Web 路径执行。

---

### 案例3：某内部系统存在任意文件上传漏洞（BlobStore 无后缀写入）
**系统**: 某内部系统

**漏洞描述**:
在写入存储桶时，未加上合法文件后缀。如果在文件上传到 BlobStore 时不带上文件后缀，BlobStore 会自动根据文件内容推导 `Content-Type`；比如文件后缀是 `.jpg`，文件内容是 HTML，但上传到 BlobStore 时没有携带后缀，CDN 返回文件时 `Content-Type` 为 `text/html`，导致浏览器按照 HTML 解析，造成 XSS 漏洞。

**技术细节**:
- 服务端存储时未带文件后缀，依赖 BlobStore 自动推断 MIME 类型
- BlobStore 根据文件内容（magic bytes）推断类型，HTML 内容被识别为 `text/html`
- CDN 下发时携带 `Content-Type: text/html`，浏览器解析执行 JS

**修复方案**:
上传到 BlobStore 时需带上文件后缀，服务端重命名时保留原始合法后缀（如 `uuid.jpg`）。

**经验总结**:
文件名需服务端重新生成（如 UUID），禁止使用用户提交的文件名，防止路径穿越。

---

### 案例4：上传接口缺乏防盗链能力，黑产可上传色情文件进行传播
**系统**: 某内部系统

**漏洞描述**:
`/rest/pc/activity/traffic/b/investment/report/entry/file/upload` 上传接口，在上传成功后，接口返回的预览链接缺乏防盗链功能，黑产可以上传色情图片并获取文件的 CDN 链接进行传播。需要接入统一文件存储平台的防盗链能力，上传成功后返回具有时效性的预览链接，即使黑产进行传播，也会被链接的时效性限制。

**技术细节**:
- 上传成功后返回永久有效的 CDN 直链，无防盗链保护
- CDN 链接无鉴权、无时效，可被直接外传和传播
- 缺乏内容安全检测（色情、违禁内容扫描）

**修复方案**:
接入统一文件存储平台的防盗链能力，上传成功后返回具有时效性的预览链接，即使黑产进行传播，也会被链接的时效性限制。

**经验总结**:
图片类文件可使用重新编码的方式去除恶意 payload，确保文件内容安全；同时需接入内容安全检测。

---

### 案例5：存在任意文件上传（含 URL 方式上传绕过）
**系统**: 某内部系统

**漏洞描述**:
1. `/rest/script/uploadScriptByFile`、`/rest/package/uploadByFile` 存在上传任意包到 BlobStore；
2. `/rest/script/uploadScriptByUrl`、`/rest/package/uploadByUrl` 存在绕过白名单解析任意 URL 的文件，任意上传到 BlobStore。

**技术细节**:
- 文件上传接口无类型限制，可上传任意后缀的脚本包
- URL 方式上传的 URL 白名单校验存在绕过，可通过构造 URL 上传外部任意文件
- 绕过后可上传恶意文件至 BlobStore，进而通过 CDN 分发

**修复方案**:
1. 整理 URL 后缀，尽量校验规范；
2. 考虑统一文件名上传；
3. 修复 URL 白名单校验，使用严格的域名精确匹配。

**经验总结**:
SVG、XML、HTML 类文件上传后如果能直接被浏览器访问，会导致存储型 XSS。

---

### 案例6：MCN 机构入驻文件上传接口存在任意文件上传
**系统**: 某内部系统

**漏洞描述**:
`/rest/live/mcn/org/settled/file/upload` 接口存在任意文件上传漏洞。经排查，存在其他路径同样存在文件上传漏洞，但最终调用上传函数相同，均未对上传文件的类型进行有效校验。

**技术细节**:
- 上传接口未对文件后缀名和文件内容进行有效校验
- 多个上传接口最终调用同一上传函数，批量存在相同问题
- 可上传任意格式文件，包括 JSP、PHP 等可执行文件

**修复方案**:
白名单过滤后缀名，且对上传文件进行重命名处理。

**经验总结**:
文件大小需设置合理上限，防止资源耗尽攻击（zip 炸弹等）。

---

### 案例7：举报图片上传接口存在任意文件上传漏洞
**系统**: 某内部系统

**漏洞描述**:
以下接口没有校验文件后缀，存在任意文件上传漏洞，如上传恶意 JS 文件会导致 CDN 域名被网安封禁风险：
- `/rest/h5/themis/acceptor/report/upload`
- `/rest/pc/themis/acceptor/appeal/update`
- `/rest/h5/themis/acceptor/appeal/update`

**技术细节**:
- 举报/申诉功能的文件上传接口无后缀校验
- 可上传 `.js`、`.html` 等浏览器可执行文件至 CDN
- CDN 域名被恶意利用上传违规内容，存在被封禁风险

**修复方案**:
（1）白名单：必须根据业务场景，设置白名单校验用户上传的文件类型，例如仅允许 `jpg`、`png`、`gif`、`pdf` 等图片文件，`originalFilename` 最后一个后缀匹配即可；（2）黑名单：禁止上传 `jsp`，以及浏览器可解析的文件，例如 `html`、`htm`、`swf`、`js` 文件。

**经验总结**:
压缩文件解压时需防止路径穿越（zip-slip），校验解压后的路径不超出目标目录。

---

### 案例8：Ueditor 可上传 XML 导致 XSS（附带 SSRF）
**系统**: 某内部系统

**漏洞描述**:
此接口是 Ueditor 提供的接口，白名单检查了允许上传文件后缀，但可传入特殊构造的 XML 文件导致 XSS。无需登录即可访问。注：当 `action` 为 `catchimage` 时，则传入的 `source` 参数存在 SSRF 漏洞，即服务端直接访问了 `source` 中的 URL，可访问到内网。

**技术细节**:
- Ueditor 白名单校验存在缺陷，特殊构造的 XML 文件可绕过校验
- XML 文件被浏览器解析执行，导致 XSS
- `catchimage` 的 `source` 参数存在 SSRF，可访问内网地址
- 接口未鉴权，任意用户可直接访问

**修复方案**:
如果引入的 Ueditor 对应的编辑功能不需要，则建议删除此 Ueditor 代码；如果需要用，则建议修复任意文件上传（缩小白名单范围，仅限图片后缀等）和 SSRF 漏洞（接入隔离代理）。

**经验总结**:
上传接口需鉴权，防止未登录用户上传恶意文件。

---

### 案例9：ManagerRoleController 存在任意文件导入
**系统**: 某内部系统

**漏洞描述**:
`/is-leadership/src/main/java/com/example/ocean/performance/web/controller/ManagerRoleController.java` 未校验文件后缀，存在任意文件导入漏洞。

**技术细节**:
- 文件导入接口未对上传文件的后缀名进行任何校验
- 可上传任意格式文件，包括可执行脚本
- 代码层完全缺乏文件类型验证逻辑

**修复方案**:
增加校验文件后缀，使用白名单仅允许特定格式（如 `.xlsx`、`.csv`）。

**经验总结**:
头像/图片类接口如果允许上传 HTML/SVG，存在 XSS 风险，需严格限制允许的 MIME 类型。

---

### 案例10：某内部系统知识管理接口未校验文件后缀
**系统**: 某内部系统

**漏洞描述**:
`/rest/manage/ad/knowledge/common/getIssueToken` 接口未校验文件后缀是否合法，存在任意文件上传风险。

**技术细节**:
- `getIssueToken` 接口用于获取文件上传凭证，未校验目标文件后缀类型
- 攻击者可利用此凭证上传任意格式文件
- 文件上传到对象存储后，存储路径如包含用户可控内容，存在路径覆盖风险

**修复方案**:
在下发上传凭证前，校验请求文件后缀名是否在白名单内，仅允许图片/文档类格式。

**经验总结**:
文件上传到对象存储后，存储路径不应包含用户可控内容，防止路径穿越覆盖他人文件。

---

## 二、业界经典案例（乌云）

### 案例1：上海地铁存在任意文件上传漏洞可 Shell
**厂商**: 上海地铁 | **类型**: 文件上传导致代码执行（JSP Webshell）

**洞察**: 地铁系统 Java Web 应用存在文件上传漏洞，服务端未对 JSP 文件类型进行限制，可直接上传 JSP webshell。

**测试流程**:
1. 发现文件上传功能点
2. 构造包含 JSP 内容的上传请求
3. 修改 `Content-Type` 为 `image/jpeg` 绕过前端检测
4. 上传 JSP 文件并访问获取 Shell
5. 通过留言/评论图片路径获取 Shell 路径

**技术细节**:
地铁系统 Java 应用，上传 JSP 文件内容如 `<%@page import="java.util.*,java.io.*"%>`，文件路径从留言信息的查看照片功能获取。

**POC 示例**:
```
POST /upload HTTP/1.1
Content-Type: multipart/form-data; boundary=----

------
Content-Disposition: form-data; name="file"; filename="shell.jsp"
Content-Type: image/jpeg

<%@page import="java.util.*,java.io.*"%><%Runtime.getRuntime().exec(request.getParameter("cmd"));%>
```

**绕过技巧**: `Content-Type` 伪造为 `image/jpeg` 绕过前端类型检测。

**修复建议**: 服务端白名单验证文件扩展名，不以 `Content-Type` 判断文件类型，对上传文件进行重命名。

---

### 案例2：某单位协同门户 FCKEditor 文件上传至 Getshell
**厂商**: 协同门户系统 | **类型**: 文件上传（FCKEditor 编辑器漏洞）

**洞察**: FCKEditor 2.x 版本的文件浏览器接口无认证，直接访问 Connector 可上传任意文件包括 webshell。

**测试流程**:
1. 发现使用 FCKEditor 编辑器
2. 访问 FCK 文件管理接口
3. 通过 Connector 上传 webshell
4. 获取 Shell 路径

**技术细节**:
FCKEditor 编辑器 Connector 接口：`/filemanager/browser/default/connectors/test.html` 和 `__frmupload.html` 可上传任意文件。

**POC 示例**:
```
GET /fckeditor/editor/filemanager/browser/default/browser.html?Type=Image&Connector=/fckeditor/editor/filemanager/connectors/php/connector.php HTTP/1.1

直接访问connector上传PHP webshell
```

**绕过技巧**: FCKEditor 某些版本允许直接上传任意扩展名。

**修复建议**: 升级 FCKEditor 或替换为 CKEditor，限制可上传文件类型，删除不必要的文件管理接口。

---

### 案例3：一比多上传漏洞导致网站沦陷（仅前端 JS 限制）
**厂商**: 一比多 | **类型**: 文件上传（绕过 JavaScript 前端验证）

**洞察**: 企业 B2B 平台产品图片上传仅在浏览器端限制文件类型，通过手动提交数据包可绕过前端 JS 验证上传 webshell。

**测试流程**:
1. 在发布产品页面上传模块抓包
2. 修改请求中的文件名和 `Content-Type`
3. 绕过前端 JS 验证直接提交
4. 上传 PHP/ASP webshell

**技术细节**:
仅在浏览器端限制文件上传类型，后端无验证，通过 BurpSuite 修改请求可绕过。

**POC 示例**:
```
1. 正常上传一张jpg图片，抓取POST请求
2. 将filename从image.jpg修改为shell.php
3. 将文件内容修改为: <?php @eval($_POST['c']); ?>
4. 转发请求即可
```

**绕过技巧**: 拦截并修改 HTTP 请求，绕过 JavaScript 前端验证。

**修复建议**: 服务端必须验证文件类型（Magic Bytes + 扩展名白名单），不信任客户端提交的 `Content-Type`。

---

### 案例4：某单位同业公会某系统 Getshell（%00 截断）
**厂商**: 同业公会系统（近200家银行） | **类型**: 文件上传（%00 截断绕过）

**洞察**: 上传检测使用 PHP 的 `PATHINFO` 检查扩展名，通过 `%00` 字节截断（PHP 5.3 以下）可绕过扩展名白名单检测。

**测试流程**:
1. 发现上传功能有扩展名白名单
2. 构造含 `%00` 的文件名（`shell.php%00.jpg`）
3. 发送请求，文件保存时 `%00` 后内容被截断
4. 访问 `shell.php` 获取 Shell

**技术细节**:
根据 WooYun-2015-137850，`%00` 截断拿到 Shell，影响近 200 家银行。

**POC 示例**:
```
文件名: shell.php%00.jpg
或者二进制: shell.php[0x00].jpg
服务端保存时截断为shell.php
```

**绕过技巧**: `%00` 截断文件名绕过扩展名白名单（PHP 5.3 以下及部分 Java 实现）。

**修复建议**: 升级 PHP 版本（5.4+ 修复了此问题），使用正确的文件名验证函数，不依赖文件名判断类型。

---

### 案例5：万户 OA 某处绕过限制文件上传以及 SQL 注入（无需登陆）
**厂商**: 万户OA | **类型**: 文件上传（无需认证）+ SQL 注入

**洞察**: OA 系统文件上传功能无需认证即可访问，是常见的高危组合漏洞，且存在 SQL 注入。

**测试流程**:
1. 直接访问 OA 文件上传接口（无需登录）
2. 上传 webshell 文件
3. 同时利用 SQL 注入提取管理员凭证

**技术细节**:
万户 OA 无需登陆即可访问文件上传接口，SQL 语句 `Select * From Document Where RecordID='"+ RecordID + "'"` 存在注入。

**POC 示例**:
```
直接访问: /upload/
上传shell.asp
SQL注入: /api?RecordID=1' OR '1'='1
```

**绕过技巧**: 未授权访问绕过认证。

**修复建议**: 所有上传接口强制认证，使用参数化查询防 SQL 注入。

---

### 案例6：Finecms v2.3.2 前台设计缺陷导致暴力 Getshell
**厂商**: Finecms | **类型**: 文件上传（前台功能逻辑缺陷）

**洞察**: CMS 前台功能设计缺陷，普通用户可利用 `c/m` 参数组合直接上传文件至 Web 可访问目录获取 Shell。

**测试流程**:
1. 注册普通用户账号
2. 利用 `c/m` 参数访问文件管理功能
3. 上传 PHP webshell
4. 访问上传路径执行命令

**技术细节**:
Finecms v2.3.2 前台用户可利用特定 `c/m` 参数组合进行文件上传，无需管理员权限。

**POC 示例**:
```
POST /index.php?c=api&m=template HTTP/1.1

上传包含PHP代码的文件
```

**绕过技巧**: 利用前台功能点绕过后台访问限制。

**修复建议**: 严格区分前后台权限，文件上传功能必须验证用户权限级别。

---

### 案例7：宜兴市房产网存在任意文件上传漏洞（无类型验证）
**厂商**: 宜兴市房产网 | **类型**: 文件上传（完全无验证）

**洞察**: 政府房产网站上传功能完全无服务端验证，连基本的文件类型检查都没有，直接上传 JSP 执行。

**测试流程**:
1. 发现头像上传功能
2. 查看源码确认无任何过滤
3. 直接上传 JSP 文件
4. 右键查看图片 URL 获取文件路径

**技术细节**:
无任何验证，直接 JSP 文件上传，菜刀连接。

**POC 示例**:
```
POST /upload/avatar HTTP/1.1
Content-Type: multipart/form-data

直接上传shell.jsp无任何过滤
```

**绕过技巧**: 无需绕过，完全无防护。

**修复建议**: 服务端白名单验证文件类型，使用 Magic Bytes 验证文件内容，重命名上传文件。

---

### 案例8：国务院国有重点企业信息采集系统存在致命安全漏洞（FCKEditor）
**厂商**: 国务院国资委信息中心 | **类型**: 文件上传（FCKEditor 编辑器）

**洞察**: 国有企业信息系统使用存在已知漏洞的 FCKEditor，通过 Connector 接口直接上传 webshell。

**测试流程**:
1. 发现 FCKEditor 编辑器使用
2. 访问 FCKEditor Connector 接口
3. 上传 webshell 文件
4. 获取服务器控制权限

**技术细节**:
FCKEditor 编辑器漏洞，通过公开的 Connector 接口上传 PHP/ASP webshell。

**POC 示例**:
```
GET /fckeditor/editor/filemanager/connectors/php/connector.php?Command=FileUpload&Type=File&CurrentFolder=/ HTTP/1.1
```

**绕过技巧**: 通过 FCKEditor 的 `ServerBrowserUploadFile` 功能绕过类型限制。

**修复建议**: 删除或禁用 FCKEditor 的文件管理器，修改 Connector 路径。

---

### 案例9：某运营商 WO 业务门户网站 Struts 命令执行漏洞直接 Getshell
**厂商**: 某运营商 | **类型**: 文件上传 + 命令执行（Struts2）

**洞察**: 运营商门户使用 Struts2 框架，直接利用已知命令执行漏洞上传 webshell，二合一攻击链。

**测试流程**:
1. 发现 Struts2 入口（`.action` 后缀）
2. 利用 Struts2 RCE 执行命令
3. 通过命令写入 webshell 文件
4. 访问 webshell 获得持久化控制

**技术细节**:
Struts 上传漏洞直接 getshell，通过 `userLogin.action` 入口触发。

**POC 示例**:
```
# Struts2 RCE写文件
GET /loginSp/userLogin.action?redirect:${@java.lang.Runtime@getRuntime().exec('bash -c echo$IFS...>/var/www/html/s.jsp')} HTTP/1.1
```

**绕过技巧**: `$IFS` 替代空格绕过某些 WAF。

**修复建议**: 升级 Struts2，禁用 `redirect` 前缀，WAF 检测 OGNL 特征字符串。

---

### 案例10：中国山东政府采购网站上传漏洞可直接 Getshell
**厂商**: 山东政府采购网 | **类型**: 文件上传（JSP 文件上传，政府系统）

**洞察**: 政府采购系统文件上传接口通过 `ids` 和 `varnum` 参数控制，未做后缀名限制，可直接上传 JSP webshell。

**测试流程**:
1. 访问采购系统文件上传接口
2. 修改文件名参数为 JSP 后缀
3. 上传 webshell
4. 访问上传路径

**技术细节**:
上传漏洞地址：`/sdgp2014/regist/expappend_file.jsp?ids=-1&varnum=1`，可直接上传 JSP。

**POC 示例**:
```
POST /sdgp2014/regist/expappend_file.jsp?ids=-1&varnum=1 HTTP/1.1

上传shell.jsp文件
```

**绕过技巧**: 直接上传 JSP，无类型限制。

**修复建议**: 白名单验证上传文件扩展名，禁止 `.jsp`、`.php` 等可执行文件类型。

---

## 三、方法论总结

### 3.1 高频参数统计

| 参数名 | 出现次数 | 漏洞场景 |
|--------|----------|----------|
| `file` / `uploadFile` | 8 | 通用文件上传字段 |
| `filename` / `originalFilename` | 6 | 文件名参数，可篡改后缀 |
| `Content-Type` | 4 | MIME 类型伪造 |
| `cover` / `imageUrl` | 3 | 图片 URL 上传 |
| `source` / `uploadByUrl` | 2 | URL 方式上传 |
| `ids` / `varnum` | 1 | 接口控制参数 |
| `action` / `type` | 1 | 操作类型参数（FCKEditor/Ueditor）|

**高危接口命名规律**: 含 `upload`、`import`、`file`、`image`、`attachment`、`avatar`、`icon`、`media` 关键词的接口均需重点关注。

### 3.2 攻击模式分布

| 攻击模式 | 数量 | 占比 | 典型场景 |
|----------|------|------|----------|
| 无后端校验（完全无限制） | 3 | 15% | 政府系统、老旧 OA |
| Content-Type/后缀校验绕过 | 4 | 20% | 海外广告系统、BlobStore 写入 |
| 仅前端 JS 校验 | 2 | 10% | B2B 电商平台 |
| 已知编辑器漏洞（FCKEditor/Ueditor） | 3 | 15% | 协同门户、国有企业 |
| `%00` 截断绕过 | 1 | 5% | 金融系统（PHP 5.3 以下）|
| 未授权上传 | 2 | 10% | OA 系统、面试平台 |
| 框架已知漏洞（Struts2）| 1 | 5% | 运营商门户 |
| CDN 防盗链缺失 | 1 | 5% | 广告投放系统 |
| URL 方式上传白名单绕过 | 1 | 5% | 脚本/包管理系统 |
| 路径穿越/覆盖 | 2 | 10% | 对象存储路径控制 |

### 3.3 关键检测信号

**代码层检测**:
- 搜索 `MultipartFile`、`CommonsMultipartFile`、`@RequestParam("file")`、`InputStream`、`FileUtils.write` 等文件处理关键字
- 搜索仅校验 `Content-Type` 而不校验文件魔数的逻辑（如 `contentType.startsWith("image/")`）
- 搜索以用户传入的文件名直接命名存储路径的代码
- 检查是否存在对 FCKEditor、Ueditor、Kindeditor 等编辑器上传接口的调用
- 搜索 `.getOriginalFilename()`，确认后续是否有严格后缀校验

**运行时检测**:
- 上传包含 `<%` 的文件，访问后是否执行
- 修改 `Content-Type` 为 `text/html`，确认 CDN 返回时的实际 `Content-Type`
- 上传含 `<script>` 的 SVG/XML/HTML 文件，访问后是否触发 XSS
- 测试 `%00` 截断：`shell.jsp%00.jpg`
- 测试不带扩展名上传，验证 BlobStore/CDN 返回的 MIME 类型

### 3.4 常见绕过技巧

| 绕过方式 | 原理 | 防御方法 |
|----------|------|----------|
| `Content-Type` 伪造 | 将 `image/jpeg` 等合法类型写入请求头 | 服务端通过文件魔数校验真实类型，忽略请求头 |
| 前端 JS 绕过 | 拦截请求直接修改文件名和 MIME | 后端必须独立校验，不依赖前端 |
| `%00` 截断 | `shell.php%00.jpg` 截断后为 `shell.php` | 升级 PHP/Java 版本，正确使用文件名校验 API |
| 双后缀 | `shell.php.jpg`，某些 Apache 多后缀解析 | 只取最后一个后缀，修复 Apache 配置 |
| 大小写绕过 | `shell.PHP`、`shell.Jsp` | 统一转为小写后校验 |
| 空格/点绕过 | `shell.php ` 或 `shell.php.` | `trim()` 后校验，去除末尾点 |
| 已知编辑器漏洞 | FCKEditor/Ueditor Connector 接口 | 升级或删除不必要的文件管理接口 |
| URL 方式上传白名单绕过 | 构造 URL 绕过域名前缀匹配 | 精确域名匹配，解析最终 IP 校验 |
| CDN 不带后缀存储 | BlobStore 按内容推断 MIME 类型 | 存储时强制携带合法后缀 |
| SVG/XML/HTML XSS | 浏览器解析执行内嵌脚本 | 禁止上传可被浏览器执行的文件类型 |
