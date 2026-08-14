# CSRF案例集

> 整合内部真实漏洞与业界经典案例，提供实战指导

## 漏洞判定前提条件

CSRF 漏洞仅针对**敏感删改操作**，以下场景不报告为 CSRF 漏洞：

| 排除场景 | 判定 | 原因 |
|----------|------|------|
| 查询接口（GET） | safe | 无副作用，不构成 CSRF 风险 |
| 删除/修改指定 ID 的接口 | safe | 攻击者无法预知目标 ID，无法定向攻击 |
| 非敏感删改（修改昵称、保存草稿、偏好设置） | risk-b | 数据影响有限，危害较低 |

**判定为 vulnerability 的条件**：接口为删改操作 + 涉及敏感数据（账号安全、支付、权限等） + 无 CSRF 防护 + 攻击者可定向（批量或无 ID 参数）。

> 注意：以下案例来自历史漏洞记录，部分案例（如 GET 型 CSRF、订阅关注等）按当前标准可能不构成漏洞，保留用于学习攻击模式。

## 一、内部真实案例

### 案例1：csrf导致直播盗用风险（绑定子账号）
**描述**: `/new/industry/aigc/auth/account/bindSubAccByQRCode` 存在 CSRF 风险，代码中 CSRF 校验不严谨，本漏洞为修复绕过。受害者只要点击恶意链接或扫描二维码，账号即可被攻击者用于直播。攻击者可以控制子账号开播，从而拥有他人直播账号开播权限。

**修复建议**: 未明确

**经验总结**: POST接口需校验CSRF Token，该Token需绑定到用户Session且不可预测；JSON请求体的CSRF防御：需检查Content-Type，不接受`application/x-www-form-urlencoded`

---

### 案例2：奖励兑换接口 CSRF 漏洞
**路径**: `gamezone-campaign/.../GzoneSfCarnivalLolMedalController.java#submitInfo`

**描述**: `/rest/gi/sf/carnival/lolMedal/submitInfo` 奖励兑换接口存在CSRF漏洞，接口未对请求来源进行验证，攻击者可诱导用户访问恶意页面静默触发兑换操作。

**修复建议**: 检验 Referer

**经验总结**: 敏感操作（修改密码、绑定手机）需二次身份验证，而不仅仅依赖CSRF Token

---

### 案例3：落地页相关接口未开启 CSRF 注解防护
**路径**:
- `REST_API/commodity/landingPage/delete`
- `REST_API/commodity/landingPage/saveLandingPage`
- `REST_API/commodity/landingPage/updateOnlineStatus`

**描述**: 上线前审计发现上述三个落地页接口未启用 CSRF 注解，攻击者可伪造跨站请求对落地页执行删除、保存、修改上线状态等高危操作。

**修复建议**: 可使用 `@TtsCSRFRefererCheck` 防护

**经验总结**: `SameSite=Strict` 的Cookie设置可以有效防御CSRF，但需注意兼容性

---

### 案例4：小店商家端运费险相关接口未做 CSRF 防护
**路径**: `ad-merchant-api/.../freightinsurance/FreightInsuranceController.java`

**描述**: 小店商家端运费险相关多个接口均未做 CSRF 防护，攻击者可构造恶意页面诱导商家触发运费险相关操作。

**修复建议**: 未明确

**经验总结**: API接口校验 Origin/Referer 头可作为CSRF的纵深防御，但不应作为唯一防护

---

### 案例5：客户罗盘系统 GET 型接口被 CSRF 利用
**描述**: 某客户罗盘平台头像处，未限制图片URL中的域名，导致可传入罗盘本身域名。当用户前端渲染头像时，浏览器会触发图片地址的访问，可访问罗盘系统的任意GET型接口，造成CSRF攻击。外部用户反馈可传入退出接口的URL，当查看头像即可退出系统；用户仅能查看自己的头像，影响有限，定为低危。

**修复建议**: 白名单检查上传图片的域名，保证是CDN域名，禁止使用业务系统的域名

**经验总结**: GET请求不应有副作用（如修改数据），否则容易被 `img`/`script` 标签触发CSRF

---

### 案例6：视频管理接口未加 CSRF 防护注解（MR审计）
**路径**:
- `PC_REST_API/video/management/update`
- `PC_REST_API/video/management/delete`
- `PC_REST_API/video/management/cut`

**描述**: MR审计发现视频管理相关接口（更新、删除、剪辑）均未添加CSRF防护注解，攻击者可诱导已登录用户访问恶意页面，静默触发视频管理操作。

**修复建议**: 添加CSRF注解

**经验总结**: CORS配置不当会破坏CSRF防护，`Access-Control-Allow-Origin` 不应设为 `*`

---

### 案例7：商品相关接口未开启 CSRF 注解防护
**路径**:
- `REST_API/ks/seller/product/all/delete`
- `REST_API/ks/seller/product/update`
- `REST_API/ks/seller/product/save`

**描述**: 小店商品相关接口（批量删除、更新、保存）未开启CSRF注解，攻击者可构造CSRF请求恶意删除或篡改商品数据。

**修复建议**: 使用 `@TtsCSRFRefererCheck`

**经验总结**: 文件上传接口同样可能存在CSRF，需校验CSRF Token

---

### 案例8：A站 passport 多个接口可被图片类型 CSRF 利用
**描述**: A站某些功能允许用户自定义展示的图片链接。显示图片时浏览器会向图片链接发起GET请求，而某些写接口支持GET和POST双方式，Referer check 无法防御图片型CSRF，可代替别人设置密码等高危操作。

**修复建议**: 将接口限制只能通过POST访问

**经验总结**: Double Submit Cookie模式需确保Cookie与请求参数中的Token一致性校验在服务端进行

---

### 案例9：小店接口无 CSRF 防御措施（投资活动报告）
**路径**: `InvestmentActivityReportController`、`InvestmentActivityReportModuleController`

**描述**: 该项目中 `InvestmentActivityReportController`、`InvestmentActivityReportModuleController` 中接口无CSRF防御措施，易受CSRF攻击。

**修复建议**: 接口中增加 `@TtsCSRFTokenCheck`、`@TtsCSRFRefererCheck`、`@TtsCSRFTokenRefresh` 注解，防御CSRF攻击

**经验总结**: 自定义请求头（如 `X-Requested-With`）可作为CSRF防护手段，因为跨域请求无法自定义头

---

## 二、业界经典案例（乌云）

### 案例1：爱拍某处CSRF漏洞（GET方式订阅）
**厂商**: 爱拍 | **类型**: CSRF（GET请求缺乏Referer/Token验证）

**洞察**: 订阅关注功能使用GET请求且未验证Referer和Token，攻击者可通过img标签在任意页面触发订阅操作

**测试流程**:
1. 分析订阅/关注功能的HTTP请求
2. 确认使用GET方式且无CSRF防护
3. 在恶意页面中嵌入img标签指向该URL
4. 诱导用户访问恶意页面触发订阅

**技术细节**:
GET请求添加订阅：addSubscribe，未验证来路Referer，可通过img标签触发

**POC示例**:
```html
<img src="http://aipai.com/subscribe?action=addSubscribe&to_uid=attacker_uid&callback=x" width=0 height=0>
```

**绕过技巧**: GET请求可被img/script/link标签跨域触发

**修复建议**: 关注/订阅等状态改变操作使用POST，验证Referer或CSRF Token

---

### 案例2：ESPCMS后台CSRF修改管理密码（无需知道原密码+视觉欺骗）
**厂商**: 易思ESPCMS | **类型**: CSRF（后台密码修改 + 视觉遮挡）

**洞察**: 后台修改密码无需验证原密码且无CSRF Token，可构造CSRF修改管理员密码，结合CSS全屏遮挡防止管理员察觉

**测试流程**:
1. 确认后台密码修改无CSRF防护
2. 构造CSRF表单
3. 添加全屏黑色CSS遮挡层防止管理员发现跳转
4. 诱导管理员访问恶意页面

**技术细节**:
修改密码无需原密码验证，无CSRF Token，结合全屏遮挡（position:fixed黑色层）实现静默攻击

**POC示例**:
```html
<html>
<table style="position:fixed;z-index:5000;width:100%;height:300%;background-color:black"></table>
<iframe src="data:text/html,<form id=f method=POST action=http://target/admin/changepassword><input name=new_password value=hacked></form><script>document.f.submit()</script>"></iframe>
</html>
```

**绕过技巧**: CSS全屏遮挡防止管理员发现重定向

**修复建议**: 修改密码必须验证原密码，添加CSRF Token，管理员重要操作需重认证

---

### 案例3：格瓦拉生活网多处CSRF（自动提交表单）
**厂商**: 格瓦拉生活网 | **类型**: CSRF（POST请求，JS自动提交）

**洞察**: 通过构造包含隐藏表单和JS自动提交的HTML页面，可在用户访问时自动发送POST CSRF请求，无需用户任何操作

**测试流程**:
1. 分析关注/评论等POST功能
2. 确认无CSRF Token
3. 构造带JS自动提交的HTML页面
4. 诱导用户访问

**技术细节**:
POST请求无CSRF Token，通过document.forms[0].submit()自动提交

**POC示例**:
```html
<html><body>
<form action="http://target/follow" method="POST">
  <input type="hidden" name="user_id" value="attacker">
</form>
<script>document.forms[0].submit();</script>
</body></html>
```

**绕过技巧**: POST请求无Token，JS自动触发

**修复建议**: 所有状态改变的POST请求添加CSRF Token，验证Referer

---

### 案例4：某游戏公司通行证CSRF漏洞（可恢复账号设置密保问题）
**厂商**: 盛大网络 | **类型**: CSRF（账号安全设置）

**洞察**: 游戏通行证的个人资料填写接口无CSRF防护，攻击者可构造CSRF让目标用户设置特定的密保答案，之后利用密保重置账号密码

**测试流程**:
1. 分析填写个人资料的POST请求
2. 构造含密保答案的CSRF表单
3. 诱导目标用户触发
4. 利用已知密保答案通过密保重置密码

**技术细节**:
提交个人资料（密保问题/答案）无来源验证，攻击者预设密保答案后可重置账号密码

**POC示例**:
```html
<form method=POST action=http://target/profile>
  <input name=question1 value=c_question1>
  <input name=answer1 value=attacker_knows>
  <input name=idCard value=340304197908257431>
</form>
```

**绕过技巧**: 无CSRF Token验证

**修复建议**: 表单提交需验证CSRF Token，账号安全设置需要二次身份验证

---

### 案例5：人人网GET方式提交状态漏洞（CSRF刷状态）
**厂商**: 人人网 | **类型**: CSRF（社交网络状态刷取）

**洞察**: 社交网络的状态发布使用GET请求，可被img标签跨站触发，批量刷状态或蠕虫传播

**测试流程**:
1. 分析发布状态的请求方式
2. 确认是GET请求
3. 构造img标签嵌入恶意页面
4. 用户访问后自动发布状态

**技术细节**:
社交平台状态发布使用GET方式，无CSRF防护，通过img标签可跨站触发

**POC示例**:
```html
<img src="http://renren.com/status/post?content=CSRF攻击内容" width=0 height=0>
```

**绕过技巧**: GET请求可被img/iframe等跨域加载

**修复建议**: 状态发布改为POST请求，添加CSRF Token验证

---

### 案例6：利用CSRF漏洞劫持会员账号（绑定攻击者邮箱）
**厂商**: 贝贝网 | **类型**: CSRF（账号绑定劫持）

**洞察**: 用户账号绑定邮箱接口有CSRF Token但该Token为固定值可预测，通过构造CSRF可将用户账号绑定到攻击者邮箱，进而重置密码完全劫持账号

**测试流程**:
1. 分析绑定邮箱请求
2. 发现hxcsrf固定Token
3. 构造CSRF将用户账号绑定到攻击者邮箱
4. 通过攻击者邮箱重置账号密码

**技术细节**:
hxcsrf Token固定为 `47c1bdc32e559d7774e220a3c2427d43`，可预测，CSRF将账号绑定到攻击者邮箱

**POC示例**:
```html
<form action="http://target/bind_email" method="POST">
  <input name="hxcsrf" value="47c1bdc32e559d7774e220a3c2427d43">
  <input name="email" value="attacker@evil.com">
</form>
```

**绕过技巧**: 固定CSRF Token可直接重用

**修复建议**: CSRF Token必须随机生成且与Session绑定，每次请求刷新

---

### 案例7：爱卡汽车两处问题（OAuth绑定CSRF + 暴力破解）
**厂商**: 爱卡汽车网 | **类型**: CSRF（OAuth绑定劫持）

**洞察**: OAuth第三方登录绑定过程未使用state参数防CSRF，攻击者可构造CSRF将受害者账号绑定到攻击者的第三方账号，实现账号劫持

**测试流程**:
1. 分析OAuth绑定流程
2. 确认缺少state参数
3. 构造CSRF将受害者账号绑定到攻击者OAuth账号
4. 使用攻击者OAuth账号登录受害者账号

**技术细节**:
OAuth绑定无token/state参数，存在CSRF劫持第三方账号绑定；手机解绑无验证码可暴力破解

**POC示例**:
```html
<img src="http://target/oauth/bind?oauth_provider=weibo&oauth_uid=attacker_uid" width=0>
```

**绕过技巧**: OAuth flow缺少state参数的CSRF保护

**修复建议**: OAuth绑定必须使用state随机参数防CSRF，解绑操作添加短信验证码

---

### 案例8：某IT教育平台某处CSRF（自动提交表单）
**厂商**: 某IT教育平台 | **类型**: CSRF（通用POST表单攻击）

**洞察**: 教育平台的状态修改接口无CSRF Token，通过自动提交表单可批量操作他人数据

**测试流程**:
1. 分析平台功能的POST请求
2. 确认无CSRF Token
3. 构造自动提交的HTML表单
4. 诱导目标用户访问

**技术细节**:
POST请求缺乏CSRF防护，通过恶意页面自动提交

**POC示例**:
```html
<html><body>
<form action="http://target/api/update" method="POST">
  <input type="hidden" name="param" value="malicious_value">
</form>
<script>document.forms[0].submit();</script>
</body></html>
```

**绕过技巧**: 无Token保护，JS自动提交

**修复建议**: 所有表单添加CSRF Token（SameSite Cookie属性也可缓解）

---

### 案例9：从一个小XSS到CSRF到某社交空间被刷爆了（业务蠕虫）
**厂商**: 某社交平台 | **类型**: XSS + CSRF蠕虫

**洞察**: XSS漏洞配合CSRF可构造自传播的蠕虫，一旦触发可在社交平台上指数级传播，危害极大

**测试流程**:
1. 发现存储型XSS漏洞
2. 在XSS中嵌入CSRF请求代码
3. CSRF自动发帖/转发，新帖子再次触发XSS
4. 形成蠕虫自我传播

**技术细节**:
XSS+CSRF蠕虫：XSS执行JS → 发CSRF请求 → 自动在其他用户页面写入XSS → 蠕虫传播

**POC示例**:
```javascript
<script>
// 蠕虫核心逻辑
var xhr = new XMLHttpRequest();
xhr.open('POST', '/api/share');
xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
xhr.send('content=<script>'+location.href+'</scr'+'ipt>');
</script>
```

**绕过技巧**: 利用CSP不完整配置绕过脚本来源限制

**修复建议**: 修复XSS漏洞（根本），CSRF Token（缓解），CSP限制内联脚本

---

### 案例10：中舞网多处CSRF全部打包（批量CSRF漏洞）
**厂商**: 中舞网 | **类型**: CSRF（批量功能漏洞）

**洞察**: 网站的多个核心功能（报名、发布、编辑等）均缺乏CSRF防护，批量漏洞表明CSRF防护未在框架级别统一实现

**测试流程**:
1. 枚举网站的POST功能
2. 逐一检查是否存在CSRF Token
3. 确认多处无防护
4. 批量报告CSRF漏洞

**技术细节**:
中舞网报名、日程等多个功能均存在CSRF，统一缺乏Token防护

**POC示例**:
```html
<form action="http://target/reg/apply" method="POST">
  <input name="startdate" value="2015-06-06">
  <input name="companyname" value="CSRF攻击">
</form>
```

**绕过技巧**: 无（未记录绕过技巧）

**修复建议**: 在框架级别统一集成CSRF Token生成和验证，所有POST请求自动验证

---

## 三、方法论总结

### 3.0 漏洞判定前提（必须首先确认）

**只有满足以下全部条件才判定为 CSRF 漏洞（vulnerability）**：

1. **删改操作**：接口为 PUT/PATCH/DELETE 或状态变更 POST（查询 GET 接口 → 不报告）
2. **敏感数据**：涉及账号安全、支付、权限、密保等敏感操作（非敏感操作如昵称修改 → risk-b）
3. **可定向攻击**：攻击者能指定攻击目标，如批量操作、无 ID 参数（指定 ID 删除/修改 → safe，攻击者不知道目标 ID）
4. **无有效防护**：无 CSRF Token、无 SameSite Cookie、无 Referer 校验

### 3.1 高频参数统计

| 参数名 | 出现场景 | 说明 |
|--------|----------|------|
| `csrf_token` / `hxcsrf` / `_token` | 表单提交 | CSRF Token字段，需验证是否为固定值或随机值 |
| `action` | GET型功能接口 | 常见于订阅、关注等操作 |
| `email` / `mobile` | 账号绑定 | 绑定操作缺乏CSRF保护易导致账号劫持 |
| `oauth_uid` / `oauth_provider` | OAuth绑定 | state参数缺失导致OAuth CSRF |
| `user_id` / `to_uid` | 社交关系操作 | 关注/取关等操作 |
| `password` / `new_password` | 密码修改 | 无原密码验证+无CSRF Token的高危组合 |
| `question` / `answer` | 密保设置 | 密保预设攻击链 |

### 3.2 攻击模式分布

| 攻击模式 | 案例数量 | 典型场景 |
|----------|----------|----------|
| GET型CSRF（img/script标签触发） | 3个 | 订阅、状态发布、头像URL引用业务接口 |
| POST型CSRF（JS自动提交表单） | 4个 | 通用表单操作、关注、报名、商品管理 |
| 账号绑定/劫持型CSRF | 2个 | 邮箱绑定（固定Token）、OAuth绑定（无state） |
| CSRF Token绕过 | 1个 | 固定Token可预测重用 |
| CSRF + 密保预设攻击链 | 1个 | 密保设置CSRF → 密保重置密码 |
| XSS + CSRF蠕虫 | 1个 | 存储型XSS与CSRF联合实现蠕虫 |
| CSS视觉欺骗辅助CSRF | 1个 | 全屏遮挡层配合CSRF表单 |
| 框架级别批量缺失 | 3个（内部） | 内部多接口统一缺失注解 |

### 3.3 关键检测信号

**前端检测信号**:
- 状态变更操作（关注、发帖、修改资料）使用GET请求
- 表单缺少 `csrf_token`、`_token` 等隐藏字段
- POST请求中无自定义防CSRF头（如 `X-Requested-With`）
- OAuth授权回调URL中缺少 `state` 参数

**后端检测信号**:
- Java接口未添加 `@TtsCSRFTokenCheck`、`@TtsCSRFRefererCheck` 注解
- 修改密码接口不验证原密码
- 账号绑定接口无二次身份验证
- CSRF Token存储在全局变量中（而非Session绑定）

**请求特征**:
- Referer 头为空或来自第三方域名时接口仍正常响应
- Content-Type 为 `application/x-www-form-urlencoded` 时JSON接口无拒绝
- 多次提交同一Token均成功（Token未消费/未刷新）

### 3.4 常见绕过技巧

| 绕过技巧 | 适用场景 | 原理 |
|----------|----------|------|
| img/script/link标签触发 | GET型接口 | 浏览器自动携带Cookie发起跨域GET请求 |
| JS自动提交表单 | POST型接口 | `document.forms[0].submit()` 无需用户点击 |
| 固定Token重用 | Token验证弱 | Token未与Session绑定，可预测或全局固定 |
| OAuth state缺失 | OAuth绑定流程 | 缺少state参数导致授权码可被CSRF重放 |
| CSS全屏遮挡 | 后台操作 | 用CSS layer遮挡页面，管理员无法察觉跳转 |
| XSS辅助绕过同源限制 | 存在XSS场景 | XSS可直接读取Token并发起CSRF请求 |
| 双向接口（GET/POST均支持） | 写操作接口 | 将POST接口通过GET方式触发绕过仅校验POST的防护 |
| JSON CSRF（Content-Type绕过） | JSON接口 | 利用Flash/特殊Content-Type向JSON接口发起CSRF |
