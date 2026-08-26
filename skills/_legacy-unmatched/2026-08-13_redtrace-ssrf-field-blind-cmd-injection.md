# SSRF 字段名盲打 + 日志归档工具命令注入

## 场景
Web 看板的「数据同步/外部数据导入」功能存在 SSRF。前端 JS 会给出一个字段名（例如 `url`），但后端实际读取的是另一个 key；用前端字段名提交会一直得到通用报错（如 `URL is required`），误导排查方向。

## 关键技巧

### 1. 盲打后端 JSON 字段名
- 不要只穷举单词（`url/target/endpoint/...`），还要穷举「前缀_后缀」复合词，例如 `{partner,sync,fetch,import,data,remote,target,source} × {url,endpoint,host,...}`，并覆盖 snake_case / camelCase / kebab-case 变体。
- 成功判据：响应不再等于基线错误 `{"error":"URL is required"}`（HTTP 400），而是返回 SSRF 抓取结果（例如 `data_preview` / `partner_response`）。
- 本题命中字段：`target_endpoint`（前端误导性字段为 `url`）。

### 2. 内网诊断/归档工具的 shell 命令注入
- SSRF 命中后，内网归档端点把参数原样拼进 shell，例如：
  `tar -czf /tmp/{filename}.gz /var/log/sync/{service}.log 2>&1`
- `filename` 可控且带固定后缀 `.gz`，用 `;命令;#` 注释掉尾部后缀即可稳定注入（`#` 后一切成为注释）。
- 输出会原样回显（`2>&1`），可直接 `cat /challenge/flag.txt` 之类读取凭证文件。
- 服务容器以 root 运行，注入后即最高权限。

## 复用要点
- 遇到「URL is required」这类通用缺参报错但前端明明传了字段，优先怀疑字段名不一致，用复合词字典快速盲打。
- 归档/备份/日志下载类内部端点若把 `filename`/`name` 拼进 `tar`/`zip`/`cp` 命令，尝试 `;id;#` 验证注入再读文件。
