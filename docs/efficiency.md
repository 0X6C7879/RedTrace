# 测评效率功能与本机验收

保留唯一 FGS、单实例 Decide、独立 Execute、Worker 路由和 DSH 原生执行器。没有新增 Agent、业务图、常驻知识服务或上游 DSH 源码补丁。

## 使用与退出

通过现有插件管理页启用/停用 `redtrace-knowledge`、`redtrace-http`、`redtrace-trace-search`、`redtrace-critical-events`。这四项效率功能新安装时默认启用，仍可显式停用；既有 manifest 中明确停用的设置继续生效。不以本地测试承诺真实得分或节省比例。重复调用提醒及其插件、尝试签名账本均已移除；正常重复查询不再注入提示。停用不删除 FGS、原始审计或证据。

- 活动 Run 用 SQL 状态索引查询，每轮派发复用活动集合；启动提示只读 Scope/根 Goal/当前 Step。
- `read_graph` 支持 `id/offset/full/kinds/limit`，每种节点在 SQL 层分页；`full:true` 仍为当前页。`graphUpdate` 排空超过 500 个事件的分页。
- 默认文本结果预算 8 KiB；原文、退出码、错误、哈希和证据引用保留。Shell 完整合并日志与独立 stdout/stderr 文件均保存，未知副作用不自动重放。JSON、扫描端口和 HTTP 状态/时间/正文差异做确定性提取；解析失败只报错并给原文入口。
- `evidence_read` 按关键词、行号或字节区间读取本 Run 的哈希校验证据，单片最多 7600 字节。
- `knowledge_search/read/match` 是模型主动使用的离线检索工具，不订阅 Fact 事件，不解析 HTTP/Nmap，不自动扫描或执行 PoC。工具描述显示库的绝对路径；`query:"CVE-2021-41773"` 精确查编号，`query:"apache"` 查组件，`component:"apache",version:"2.4.49"` 查版本范围，也接受 `query:"Apache 2.4.49"`。可用 vendor/CPE 消歧；没有版本仍返回相关漏洞，未知版本/环境保持 unknown。SQLite 主键、组件索引和 FTS5 完成检索，返回分页短摘要、版本范围、来源路径；`knowledge_read` 按 CVE 或来源哈希每次读取最多 8 KiB。数据库和源文件做 SHA256 完整性校验（不是数字签名）。本地库查询不依赖互联网，不自动下载、更新或在线回退；辅助进程不强制断网，并保留网络代理环境。维护用 `./install-knowledge.sh --online` 获取 NVD 2.0、Nuclei、ExploitDB 快照；离线安装用 `./install-knowledge.sh --offline --package /absolute/path/data.tar.gz`，Python wheelhouse 需按平台提前准备。默认数据目录为仓库的 `.redtrace/data/knowledge`，可用 `REDTRACE_DATA_DIR` 覆盖；`node scripts/knowledge.mjs status|export|rollback` 管理数据代际。
- `http_batch/http_replay`：仅使用 Playwright request API，不创建 Browser、BrowserContext 或 Page；Playwright 和依赖保留。HTTP 会话作为 `http_session` Resource 在同 Project 内跨 Step/Worker 共享，`session` 可省略，返回 Resource id 可显式复用。身份或显式 challenge namespace 可分开 Cookie；不按 Step 隔离、不按固定 8 个或 15 分钟销毁。Cookie 状态私有落盘，停止 Project 不删除；Resource 关闭/退役/删除或 Project 删除时清理。完整请求响应按哈希归档。
- 自建 `web_open/web_snapshot/web_act/web_network` 已删除，不引进任何 DSH Browser Provider。DSH `web_search/web_fetch` 是搜索与公开页面抓取，不是浏览器，保持原生实现。
- `http_replay` 使用 `http_batch` 返回的 Request ID、原始方法/Body/Headers 和当前 Cookie，允许明确的 POST/Token/查询变体；只执行显式变体，不增加隐藏 baseline 请求，不自动重试。批量请求按最多 4 个并行分批，不以固定批量数量拒绝。
- BrowserContext 按 Project/Challenge/身份/Session 隔离；同一会话操作串行。不按 Scope 或 SDK Host 白名单拦截访问；目标选择由 FGS 负责。ARIA 快照提供变化标记；表单、隐藏字段和网络原文完整存证。局部截图需显式 `screenshot:true,selector`；失败动作使旧 snapshot_id 失效。
- HTTP 串行默认；`parallel:true` 是对请求明确独立的声明，最多 4 并发。Cookie 共享不代替 Authorization/CSRF，调用者须显式提供；一次性参数不会自动重放。JSON 响应比较返回有界字段路径差异，不将差异直接当成漏洞。响应持久化后 dispose；展示差异不删除异常证据。取消使受影响的身份会话失效。验证码仅供当前模型通过授权局部截图尝试；无法识别应记录阻塞、转向，不承诺通用通过。
- 五个 DSH 原生 Session Query 工具按需检索 Session JSONL / live 历史，以官方 cwd 授权强制 Project 隔离；不迁移旧 Trace，不自动注入历史。
- 只有 SDK 确认得分、运行时 probe/路由验证或已验证能力失效产生关键事件。事件合并、去重，只唤醒现有 Decide；满 Step 容量可重排但 add_step 不越限。成功只确认启动边界，失败/暂停和迟到事件保留。DSH 执行器使用统一关键提醒判定。
- Pivot 支持受管 SSH SOCKS（非交互式密钥/既有 SSH 配置）及 Chisel；监听启动不算路径成功。`pivot_validate` 通过指定本地 SOCKS 访问授权 HTTP(S) 服务并观察响应，受 Project 和租约控制。认证、上游或代理失效会撤销验证并级联使依赖通道降级；重新验证后恢复。Ligolo 不可派发。

## 成本与冻结

`node scripts/efficiency-manifest.mjs [配置路径] [题单路径...]` 输出源码、配置、插件、模型和可选题单哈希，不导出密钥。`GET /audit/tasks/:project/costs` 提供每 Run 的原生 Token 四个互斥桶、缓存单列、模型/工具/平台耗时、未结束调用及 `waitOrUninstrumentedMs`。计时边界不覆盖历史缺失数据，DSH 模型边界包含准备/重试；残差不是纯平台等待。图片 Token 不可单独归因时为 null，不伪造精度。

## 本机验收边界

确定性测试覆盖 SQL 大图/历史 Run、超过 500 事件、输出原文/哈希/stderr、重复调用不注入提醒且保留审计/恢复跟踪、历史 Trace 回填与隔离、登录/Cookie/显式 CSRF/一次性参数、局部截图、失败动作/过期快照、关键事件边界/去重/失败/暂停/满容量、SOCKS 目标不可达、跨 Project 拒绝、租约冲突、能力失效和真实本地受管 Chisel 转发。Engine 与 DSH 全量测试均须通过后才能提交。

用户本轮明确不做真实环境测评。因此没有运行收费平台、真实 SSH 登录、CAPTCHA 模型或 A/B 题单；不宣称得分、完成率或 Token/时间收益。四项效率插件新安装时默认启用，仍可在插件管理页显式停用；后续真实收益仍需原计划的固定模型、环境恢复和每题两组各 3 次配对验证。

## Reason 实时 FGS 维护（2026-10-11）

普通 Fact/Finding 新增均进入持久化待规划序列，不依赖 Execute 结束或 Step 空位；全局/项目/Worker 并发仍受限，无 Reason 预留容量。忙时只注入简短节点/边界提醒，增量读取不等于确认处理。维护默认只读活跃节点，查询过滤与分页在 SQL 层完成；没有新增模型、图数据库或后台语义合并。

原生 DSH 测试通过脚本化本地模型服务验证跨 Explore 提交、Reason 忙时提醒、同会话 amend、执行前旧动作拦截与 sync_step。它不是实际模型或真实 TSecBench 收益证明；生产服务不会为这次验证自动重启，真实成功数/token/延迟对比仍需独立、可重置的测评环境。

## 原生 Session Query

`redtrace-trace-search` 保留既有 UI 名称和 manifest 开关，内部改为 DSH 官方 SQLite Session Query 与五个原生工具：`session_search`、`session_event_search`、`session_event_read`、`session_trace`、`session_event_trace`。Reason、Explore、Bootstrap 共享该工具栈。Reason 可使用五个查询工具和全文 `read`，不获得 Shell、写文件等执行权限。

所有 Session 的 header.cwd 仍是独立的 Project 工作目录。同 Project 跨 Worker、跨角色、跨题目共享全部历史，模型自行判断相关性；DSH 官方 cwd 相等授权拒绝跨 Project 读取。仅模型主动调用查询，不做自动检索或 Challenge 映射。仅 Explore / Bootstrap 的大结果复用 DSH Spill；Reason 不挂载 Spill。Reason 的 `read` 默认完整返回 UTF-8 文件，不设路径、行数、单行长度或字节上限，仍可显式用 offset/limit 分段。路径仅受操作系统权限约束，包含跨项目路径、符号链接与凭据文件；Session Query 的跨项目授权保持不变。

索引 `.redtrace/sessions/session-query.sqlite` 在首次搜索时打开，由官方服务从 live Session 与持久 JSONL 重建；暂停恢复沿用原 Session ID。旧 `trace_search` / `trace_read`、重复 FTS 和游标已删除；启动清理旧派生表，不迁移 Trace 历史。原始 `run_events`、`audit_events`、FGS、现有 Web 展示保留。插件停用不删除 Session 与派生索引，下次开启可继续查询。
