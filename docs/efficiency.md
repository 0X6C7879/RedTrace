# 测评效率功能与本机验收

保留唯一 FGS、单实例 Decide、独立 Execute、Worker 路由和 DSH 原生执行器。没有新增 Agent、业务图、常驻知识服务或上游 DSH 源码补丁。

## 使用与退出

通过现有插件管理页启用/停用 `redtrace-knowledge`、`redtrace-critical-events`。这两项效率功能新安装时默认启用，仍可显式停用；既有 manifest 中明确停用的设置继续生效。不以本地测试承诺真实得分或节省比例。重复调用提醒及其插件、尝试签名账本均已移除；正常重复查询不再注入提示。停用不删除 FGS、原始审计或证据。

- 活动 Run 用 SQL 状态索引查询，每轮派发复用活动集合；启动提示只读 Scope/根 Goal/当前 Step。
- `read_graph` 支持 `id/offset/full/kinds/limit`，每种节点在 SQL 层分页；`full:true` 仍为当前页。`graphUpdate` 排空超过 500 个事件的分页。
- 默认文本结果预算 8 KiB；原文、退出码、错误、哈希和证据引用保留。Shell 完整合并日志与独立 stdout/stderr 文件均保存，未知副作用不自动重放。JSON、扫描端口和 HTTP 状态/时间/正文差异做确定性提取；解析失败只报错并给原文入口。
- `evidence_read` 按关键词、行号或字节区间读取本 Run 的哈希校验证据，单片最多 7600 字节。
- `knowledge_search/read/match` 是模型主动使用的离线检索工具，不订阅 Fact 事件，不解析 HTTP/Nmap，不自动扫描或执行 PoC。工具描述显示库的绝对路径；`query:"CVE-2021-41773"` 精确查编号，`query:"apache"` 查组件，`component:"apache",version:"2.4.49"` 查版本范围，也接受 `query:"Apache 2.4.49"`。可用 vendor/CPE 消歧；没有版本仍返回相关漏洞，未知版本/环境保持 unknown。SQLite 主键、组件索引和 FTS5 完成检索，返回分页短摘要、版本范围、来源路径；`knowledge_read` 按 CVE 或来源哈希每次读取最多 8 KiB。数据库和源文件做 SHA256 完整性校验（不是数字签名）。本地库查询不依赖互联网，不自动下载、更新或在线回退；辅助进程不强制断网，并保留网络代理环境。维护用 `./install-knowledge.sh --online` 获取 NVD 2.0、Nuclei、ExploitDB 快照；离线安装用 `./install-knowledge.sh --offline --package /absolute/path/data.tar.gz`，Python wheelhouse 需按平台提前准备。默认数据目录为仓库的 `.redtrace/data/knowledge`，可用 `REDTRACE_DATA_DIR` 覆盖；`node scripts/knowledge.mjs status|export|rollback` 管理数据代际。
- 自建 HTTP 批量请求、重放和 Cookie 持久化已退役；原有审计和证据不迁移、不删除。
- 自建 `web_open/web_snapshot/web_act/web_network` 已删除，不引进任何 DSH Browser Provider。DSH `web_search/web_fetch` 是搜索与公开页面抓取，不是浏览器，保持原生实现。
- 五个 DSH 原生 Session Query 工具按需检索 Session JSONL / live 历史，以官方 cwd 授权强制 Project 隔离；不迁移旧 Trace，不自动注入历史。
- 只有 SDK 确认得分、运行时 probe/路由验证或已验证能力失效产生关键事件。事件合并、去重，只唤醒现有 Decide；满 Step 容量可重排但 add_step 不越限。成功只确认启动边界，失败/暂停和迟到事件保留。DSH 执行器使用统一关键提醒判定。
- Pivot 支持受管 SSH SOCKS（非交互式密钥/既有 SSH 配置）及 Chisel；监听启动不算路径成功。`pivot_validate` 通过指定本地 SOCKS 访问授权 HTTP(S) 服务并观察响应，受 Project 和租约控制。认证、上游或代理失效会撤销验证并级联使依赖通道降级；重新验证后恢复。Ligolo 不可派发。

## 审计修复（2026-11-03）

- 角色和 Skill 不注入固定活跃实例数；比赛限制由任务输入提供，Worker/Step 调度容量仍有效。
- 模型工具结果、run_events、audit_events 原样保存，不再脱敏；审计文件/API 含完整凭据及响应，须按敏感数据控制访问。配置密钥的加密存储与原有文件访问边界保留。
- Step 结束仍必须显式 submit_fact；无突破时提交经验证的失败、限制或阻塞汇总，不以 Observation 或纯文本代替。
- SQLite 使用 WAL/NORMAL；文本/推理 delta 只推送内存 SSE，定稿消息和生命周期仍落库。NORMAL 在系统断电时可能丢失最近提交，不能视为 FULL 的耐久性等价替代。
- 配置及 MCP 解析缓存按文件指纹失效；live-plan 复用相同图版本快照，契约变更仍保留同步与旧调用树保护，不承诺供应商 Prompt Cache 命中。
- 调度查询排除已结束历史 Step，但保留 Bootstrap 门控。Fact 合并只改引用，不改 planVersion；真实 amend/replace 仍使旧契约失效。
- 远程操作使用完成事件唤醒；本地文本索引改为 Worker 线程且刷新间隔 15 分钟。复杂 CPE/版本匹配保留既有 Python 语义，同一数据库复用短暂查询进程，空闲 30 秒退出（空闲管道 unref，不阻止引擎退出）；未重写为纯 Node 版本比较器。首次 SHA256 校验保留，防止跳过完整性验证。
- Reason 默认分页 2000 行，拒绝超过 8 MiB 的文件及含 NUL 的二进制文件；不改变路径访问规则。webshell/c2 注册接口仍复用现有本机 HTTP API，未绕过其校验。

## 成本与冻结

`node scripts/efficiency-manifest.mjs [配置路径] [题单路径...]` 输出源码、配置、插件、模型和可选题单哈希，不导出密钥。`GET /audit/tasks/:project/costs` 提供每 Run 的原生 Token 四个互斥桶、缓存单列、模型/工具/平台耗时、未结束调用及 `waitOrUninstrumentedMs`。计时边界不覆盖历史缺失数据，DSH 模型边界包含准备/重试；残差不是纯平台等待。图片 Token 不可单独归因时为 null，不伪造精度。

## 本机验收边界

确定性测试覆盖 SQL 大图/历史 Run、超过 500 事件、输出原文/哈希/stderr、重复调用不注入提醒且保留审计/恢复跟踪、历史 Trace 回填与隔离、局部截图、失败动作/过期快照、关键事件边界/去重/失败/暂停/满容量、SOCKS 目标不可达、跨 Project 拒绝、租约冲突、能力失效和真实本地受管 Chisel 转发。Engine 与 DSH 全量测试均须通过后才能提交。

用户本轮明确不做真实环境测评。因此没有运行收费平台、真实 SSH 登录、CAPTCHA 模型或 A/B 题单；不宣称得分、完成率或 Token/时间收益。两项效率插件新安装时默认启用，仍可在插件管理页显式停用；后续真实收益仍需原计划的固定模型、环境恢复和每题两组各 3 次配对验证。

## Reason 实时 FGS 维护（2026-10-11）

普通 Fact/Finding 新增均进入持久化待规划序列，不依赖 Execute 结束或 Step 空位；全局/项目/Worker 并发仍受限，无 Reason 预留容量。忙时只注入简短节点/边界提醒，增量读取不等于确认处理。维护默认只读活跃节点，查询过滤与分页在 SQL 层完成；没有新增模型、图数据库或后台语义合并。

原生 DSH 测试通过脚本化本地模型服务验证跨 Explore 提交、Reason 忙时提醒、同会话 amend、执行前旧动作拦截与 sync_step。它不是实际模型或真实 TSecBench 收益证明；生产服务不会为这次验证自动重启，真实成功数/token/延迟对比仍需独立、可重置的测评环境。

## 原生 Session Query

`redtrace-trace-search` 保留既有 UI 名称和 manifest 开关，内部改为 DSH 官方 SQLite Session Query 与五个原生工具：`session_search`、`session_event_search`、`session_event_read`、`session_trace`、`session_event_trace`。Reason、Explore、Bootstrap 共享该工具栈。Reason 可使用五个查询工具和全文 `read`，不获得 Shell、写文件等执行权限。

所有 Session 的 header.cwd 仍是独立的 Project 工作目录。同 Project 跨 Worker、跨角色、跨题目共享全部历史，模型自行判断相关性；DSH 官方 cwd 相等授权拒绝跨 Project 读取。仅模型主动调用查询，不做自动检索或 Challenge 映射。仅 Explore / Bootstrap 的大结果复用 DSH Spill；Reason 不挂载 Spill。Reason 的 `read` 默认完整返回 UTF-8 文件，不设路径、行数、单行长度或字节上限，仍可显式用 offset/limit 分段。路径仅受操作系统权限约束，包含跨项目路径、符号链接与凭据文件；Session Query 的跨项目授权保持不变。

索引 `.redtrace/sessions/session-query.sqlite` 在首次搜索时打开，由官方服务从 live Session 与持久 JSONL 重建；暂停恢复沿用原 Session ID。旧 `trace_search` / `trace_read`、重复 FTS 和游标已删除；启动清理旧派生表，不迁移 Trace 历史。原始 `run_events`、`audit_events`、FGS、现有 Web 展示保留。插件停用不删除 Session 与派生索引，下次开启可继续查询。
