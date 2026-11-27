# CTFy 平台接口说明

## 当前契约来源

以官方 MCP `https://ctfy.tsinghua.edu.cn/api/v1/mcp/` 的 `tools/list` 为准，可用 `python3 scripts/tpctf.py mcp tools` 获取实时 Schema。本次实测 `/openapi.json` 返回前端 HTML，不是 OpenAPI JSON，不应再据此生成接口。

CTFy 是通用平台：`list_competitions` 返回 `event` / `suite`；比赛应显式指定 `competition_id`，不能按 TPCTF/Agent 标题自动选择。当前可用性与实例上限由目标字段决定，不由旧赛程决定。

MCP 使用 Streamable HTTP：JSON-RPC `initialize` → `notifications/initialized` → `tools/list` / `tools/call`；接收 JSON 或 SSE 响应，保留协商的协议版本和服务端 Session ID。CLI 保留原始工具结果，`structuredContent` 是结构化输出；`isError=true` 或 JSON-RPC `error` 为失败。不要把 Claude 用户范围 MCP 配置当作 RedTrace Worker 配置。

常用工具：`list_competitions`、`get_competition`、`list_competition_challenges`、`get_challenge`、`list_instances`、`start_instance`、`get_instance`、`submit_answer`、`stop_instance`、`get_scoreboard`。更多能力按 `tools/list` 发现，CLI 的 `mcp call` 可直接传参数，不需要为每个工具再添加 REST 包装。

附件：`per_team` 需从实例级 `download_instance_attachment` 获取；普通静态文件用 `download_challenge_attachment`。返回 `encoding=base64` 时解码，不能把 base64 当文件原文；`too-large` 不是已完整下载。

## REST 子命令契约

下表保留原 v1.0 文档中 REST 子集，读取、启动、查询、VPN 下载和释放路径已在线验证；其余尤其出题接口仍需以当前平台能力核对。

- Base URL：`https://ctfy.tsinghua.edu.cn/api/v1`
- 鉴权：`Authorization: Bearer pf_...`。Token 权限由平台决定；CLI 接受 `CTFY_TOKEN` 和原有专用 Token，不能假设具备出题或报名权限。
- 错误：`{"code":"error_code","detail":"...","timestamp":"..."}`，以 `code` 判断分支。

## 解题

| 操作 | 方法和路径 | 关键信息 |
|---|---|---|
| 比赛 | GET `/competitions` | `items[].id`, `title`, `kind`, `phase`, `play_open`, `is_registered`, `my_team_id`, `max_instances_per_team_effective` |
| 题目 | GET `/competitions/{competition_id}/challenges` | `items[].id`, `scoring`, `closed`, `my_team_fully_solved`, `my_team_authored`，支持 `limit/offset` |
| 详情 | GET `/challenges/{challenge_id}` | `name`, `description`, `category`, `attachments`, `questions[]`, `requires`, `launch_ttl_s` |
| 开实例 | POST `/instances` | JSON `{"challenge_id":"...","competition_id":"..."}`，成功 202、返回 `id`, `status=starting` |
| 查实例 | GET `/instances/{instance_id}` | `status`, `services`, `entry_urls`, `vpn_endpoint.config_url`, `questions[].attempts_remaining`, `expires_at` |
| VPN 配置 | GET `/instances/{instance_id}/vpn-config` | 文档第 9.1 节，携带 Bearer，返回 WireGuard 配置文件 |
| 提交 | POST `/submissions` | JSON `{"instance_id":"...","question_id":"...","answer":"..."}` |
| 关闭实例 | DELETE `/instances/{instance_id}` | 成功 202，返回 `status=stopping` 和 `teardown_pending` |
| 排名 | GET `/competitions/{competition_id}/scoreboard` | `rank`, `score`, `attack_score`, `solved`, `flags_solved`, `last_solve_at` |

### 多问题和动态 Flag

- `questions[].id` 用于 `question_id`。`requires` 列出前置问题 ID；答对后需重新请求 `GET /challenges/{id}` 获取新问题。
- 每个问题可能有 `attempts_cap`/`attempts_remaining`；用完返回 429 `question_attempt_cap_exceeded`。不能爆破提交 API。
- Flag 按赛道/队伍/实例动态生成；**必须用当前本队 `instance_id`** 提交。
- 响应 `correct` 表示本次答案正确、`ranked` 表示计分、`challenge_fully_solved` 表示整题完成；`solve_rank` 一血/二血/三血/普通值，重复提交不加分。
- 以实例 `services[].access` 和 `vpn_backend` / `vpn_endpoint` 决定 TLS/SNI、普通 TCP 或 VPN。不同比赛网络规则不同，不把旧 TPCTF 的 VPN 要求套用整个平台。
- `close` 是异步操作，资源槽位释放前可能处于 `stopping`。

### 典型错误

- 鉴权：`http_401`, `http_403`, `token_competition_forbidden`, `token_missing_scope`, `not_registered`, `team_disqualified`
- 赛程：`competition_not_started`, `competition_not_in_session`, `competition_paused`, `challenge_not_released`, `challenge_closed`
- 实例：`instance_already_running` (409), `team_capacity_exceeded` (429), `capacity_exceeded` (503), `dedicated_pool_unavailable` (503), `instance_not_found` (404)
- 提交：`question_locked`, `unknown_question_id`, `answer_not_one_value`, `question_attempt_cap_exceeded`, `judge_unavailable`
- 排名封榜：`silent_standings` (403)，封榜期间可能只返回冻结时榜单

## 出题（旧文档子集，需要当前平台权限）

| 操作 | 方法和路径 |
|---|---|
| 主题 | GET `/competitions/{cid}/topics` |
| 模板 | GET `/authoring/template?category=web&stack=python-flask&competition_id={cid}` |
| 配额 | GET `/competitions/{cid}/authoring/quota` |
| 上传 | POST `/competitions/{cid}/authored-challenges`，`multipart/form-data` |
| 静态检查 | GET `/competitions/{cid}/authored-challenges/{id}/audit` |
| 题目状态 | GET `/competitions/{cid}/authored-challenges` |
| 修订 | POST `/competitions/{cid}/authored-challenges/{id}/revisions`，`multipart/form-data` |

- 上传 `file` 是 `.zip`/`.tar.gz`、单一顶层目录。`slug` 必填。其他要求字段按平台具体赛事配置判断：`license`, `provenance`, `ai_assisted`, `source_url`, `accepted_terms_version`, `credit`, `note`, `replaces`。
- 题目包含 `solution/exploit.py`、`solution/WRITEUP.md`，且遵循动态 Flag 与可验证参考解要求。
- 主题按轮次发布；上传后静态检查/自动验题/审核独立进行，不能把 `review_status=pending` 当通过；审核通过后必须用 revisions 接口。
- `smoke_verdict=solved` 是参考解验证通过；`unsolved`, `estate_failed`, `malformed` 等失败需要检查。
- 每轮出题限额与提交时间要读取 `quota.upload_window`，不会因为入围赛测试了出题 Agent 就保证正式出题权限。
