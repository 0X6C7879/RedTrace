# 测评效率功能与本机验收

保留唯一 FGS、单实例 Decide、独立 Execute、Worker 路由和 Pi/DSH 适配器。没有新增 Agent、业务图、常驻知识服务或上游 DSH 源码补丁。

## 使用与退出

通过现有插件管理页启用/停用 `redtrace-knowledge`、`redtrace-browser-http`、`redtrace-trace-search`、`redtrace-critical-events`。这些新增插件默认关闭；不以本地测试承诺真实得分或节省比例。版本化尝试提醒复用 `redtrace-repeat-reminder`，FGS DSH 会话不再叠加原生重复提醒。停用不删除 FGS、原始审计或证据。

- 活动 Run 用 SQL 状态索引查询，每轮派发复用活动集合；启动提示只读 Scope/根 Goal/当前 Step。
- `read_graph` 支持 `id/offset/full/kinds/limit`，每种节点在 SQL 层分页；`full:true` 仍为当前页。`graphUpdate` 排空超过 500 个事件的分页。
- 默认文本结果预算 8 KiB；原文、退出码、错误、哈希和证据引用保留。Shell 完整合并日志与独立 stdout/stderr 文件均保存，未知副作用不自动重放。JSON、扫描端口和 HTTP 状态/时间/正文差异做确定性提取；解析失败只报错并给原文入口。
- `evidence_read` 按关键词、行号或字节区间读取本 Run 的哈希校验证据，单片最多 7600 字节。
- `knowledge_search/read` 使用本地 FTS5，默认前 5 项，来源路径和哈希可核对；缺失版本、组件和前提明确为 unknown。SecLists 仅索引目录、文件数和规模；不下载知识，不自动运行 PoC，不索引已识别的 flag/题解文件。源文件改变会拒绝旧片段并使下一次搜索重建索引。
- 尝试签名保存完整输入顺序和编码、题目、身份、资源/通道和认证环境版本。第 3 次相同尝试仅提醒一次，不阻断任意 Shell，不自动缓存或重放有副作用、超时和未知结果。
- `web_open/snapshot/act/network/http_batch`：明确传入 `challenge/identity/session` 可跨 Worker 复用同一身份；省略 challenge 则按 Step 隔离。简单 HTTP 不启动浏览器；需要页面时使用现有 Playwright，缺少 bundled Chromium 时本机自动使用已安装 Edge。
- BrowserContext 按 Project/Challenge/身份/Session 隔离；同一会话操作串行。只访问 Scope 或 SDK 验证启动的目标。ARIA 快照提供变化标记；表单、隐藏字段和网络原文完整存证。局部截图需显式 `screenshot:true,selector`；失败动作使旧 snapshot_id 失效。
- HTTP 串行默认；`parallel:true` 是对请求明确独立的声明，最多 4 并发。Cookie 共享不代替 Authorization/CSRF，调用者须显式提供；一次性参数不会自动重放。响应持久化后 dispose；展示差异不删除异常证据。取消使受影响的身份会话失效。验证码仅供当前模型通过授权局部截图尝试；无法识别应记录阻塞、转向，不承诺通用通过。
- `trace_search/read` 默认前 5 项，从历史 Native Run/Audit 分页派生，强制 Project 隔离；可重建，不注入完整历史。
- 只有 SDK 确认得分、运行时 probe/路由验证或已验证能力失效产生关键事件。事件合并、去重，只唤醒现有 Decide；满 Step 容量可重排但 add_step 不越限。成功只确认启动边界，失败/暂停和迟到事件保留。Pi/DSH 共用关键提醒判定。
- Pivot 支持受管 SSH SOCKS（非交互式密钥/既有 SSH 配置）及 Chisel；监听启动不算路径成功。`pivot_validate` 通过指定本地 SOCKS 访问授权 HTTP(S) 服务并观察响应，受 Project 和租约控制。认证、上游或代理失效会撤销验证并级联使依赖通道降级；重新验证后恢复。Ligolo 不可派发。

## 成本与冻结

`node scripts/efficiency-manifest.mjs [配置路径] [题单路径...]` 输出源码、配置、插件、模型和可选题单哈希，不导出密钥。`GET /audit/tasks/:project/costs` 提供每 Run 的原生 Token 四个互斥桶、缓存单列、模型/工具/平台耗时、未结束调用及 `waitOrUninstrumentedMs`。计时边界不覆盖历史缺失数据，DSH 模型边界包含准备/重试；残差不是纯平台等待。图片 Token 不可单独归因时为 null，不伪造精度。

## 本机验收边界

确定性测试覆盖 SQL 大图/历史 Run、超过 500 事件、输出原文/哈希/stderr、签名顺序/编码/身份/题目与状态变化、历史 Trace 回填与隔离、登录/Cookie/显式 CSRF/一次性参数、局部截图、失败动作/过期快照、关键事件边界/去重/失败/暂停/满容量、SOCKS 目标不可达、跨 Project 拒绝、租约冲突、能力失效和真实本地受管 Chisel 转发。Engine 与 DSH 全量测试均须通过后才能提交。

用户本轮明确不做真实环境测评。因此没有运行收费平台、真实 SSH 登录、CAPTCHA 模型或 A/B 题单；不宣称得分、完成率或 Token/时间收益。新增能力保持 opt-in，后续真实收益仍需原计划的固定模型、环境恢复和每题两组各 3 次配对验证。
