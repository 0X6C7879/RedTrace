# 多阶段执行优化：实施与验收状态

工作目录为 `/Users/lxy/Downloads/RedTrace`，分支 `main`。原始功能对照基线为 `d9b862ece53c1594b7bf4973efa967c6698d98b6`；本次增量回归基线为 `ab732399`。这是一份源码与夹具验收记录，不是实际渗透题成功率报告；本次增量未提交、未推送、未重启现有服务。

## 全 P0/P1 覆盖清单

| 项目 | 本轮已实现或修复 | 尚未完成/尚未验收 |
|---|---|---|
| P0-1 执行正确性 | 版本化结果；缺帧拒绝；TCP 完成边界；CLI 退出码不冒充远端码；失败/未知/取消证据；有界摘要 | 真实 Windows/WinRM、外部 C2 契约、所有编码与大输出环境矩阵 |
| P0-2 真实能力 | Worker 验证字段不可自报；SFTP 上传/下载独立适配器且按 `operationSupported` 在匹配阶段再次校验；via 严格匹配；同主机歧义拒绝；重启不伪造连接 | 其他通道能力的真实后端逐项验证；真实重连；身份/网络环境选择 |
| P0-3 持久终端 | Resource 托管 SSH PTY、增量读取/expect/send/resize/signal/close；terminal Resource 跨 Step；独占写租约与 fencing；租约申请失败会关闭新建 PTY；插件默认启用；本地 SSH PTY 夹具覆盖跨 Run 接管 | 真 SSH PTY、TCP 持续交互、前端输入/接管、完整项目生命周期与真实服务端兼容 |
| P0-4 会话仲裁 | 单写者；释放后 fencing 单调递增；Run 租约清理；旧 token 被拒绝；本地双 Worker 交接夹具通过；Beacon 单资源串行 | 原子人工接管、租约过期后进程同步核验、Worker 崩溃全流程 |
| P0-5 Host/Route | Host/Terminal/Entry 类型；受管 SSH Forward/Chisel Provider 与生命周期入口；已验证 TCP SOCKS HTTP(S) 端点才能列为可用路径；Pivot 插件默认启用 | 有向多跳图搜索、命名空间、实际经代理目标服务验证、依赖失效传播、TUN/Ligolo 与完整隧道清理 |
| P0-6 文件正确性 | SSH 使用 SFTP；读取不要求 command；结构化输入校验；写入/创建默认不覆盖；风险不能降级；Unicode/空格路径与二进制/空文件夹具通过 | Linux/Windows/CMD/PowerShell 真实环境完整矩阵与并发修改 |
| P1-1 可靠传输 | SSH/SFTP upload/download 使用流式传输、临时发布、SHA-256 校验、已匹配前缀续传、Artifact 目录约束；本地 Operations 夹具验证 Worker A 下载生成的共享 File 可供 Worker B 上传复用 | 其他通道传输、真实 SFTP/大文件/断线/并发修改验收；源文件变化和恢复策略矩阵 |
| P1-2 探测/升级 | 可关闭、按 requires 调用的最小会话探测；自报与验证分离 | 探测预算/有效期、提权环境变化刷新、受控升级、原通道保留验证 |
| P1-3 协同/恢复 | 稳定 task_id 与 attempt_id；旧尝试/迟到结果拒绝；不盲目重放；失同步原始 TCP 关闭 | 有限重连、只读重试、受控写后置条件、取消后同步、恢复 Skill、端到端故障矩阵 |
| P1-4 模板/入口 | Entry 资源类型存在，未知结果不认成功 | 模板、部署、探测、登记独立流程及其契约测试；入口验证和管理工具未交付，不开放自动部署 |
| P1-5 协议/信息 | Beacon v1 尝试与结果契约；外部结果严格校验；凭据和命令材料不返回常规资源列表；人工显式读取命令材料并审计 | 插件 Adapter 注册接口、完整秘密信息接口、历史协议兼容与契约示例 |
| P1-6 Ligolo | 保存已有 Provider 草稿但不开启 | 隔离靶场 TUN/路由专项授权、实际三层可达性、Agent/Proxy 生命周期与可验证撤销 |

## 验收与发布边界

本地确定性测试覆盖 HTTP 200 缺帧、850ms 输出间隔、结果未知、失败证据、摘要边界、租约冲突与失效 fencing、授权撤销/精确目标/Route、Beacon 不支持文件、旧尝试、串行派发、Worker 自审批拒绝、插件停用及数据库快照。完整命令、stdout、stderr、退出码和源哈希保存在 `.redtrace/verification/multistage/VERIFICATION.txt`。

日志页修复：当前 DSH `tool/result` 把结果块直接放在 `message.content`，旧投影误按旧包装层读取，导致工具完成事件缺名称/文本结果。投影现在兼容直接块与旧包装，工具完成事件保留工具名、调用 ID、错误状态和文本结果；日志 UI 通过调用 ID 补全命令，并对确实没有文本输出的完成事件显示明确占位。新增投影与 UI 行为回归；完整浏览器渲染及历史空结果回填尚未验证。

本轮 Engine 115/118 通过（3 项浏览器场景跳过）、DSH 40/40 通过；Engine 类型检查、DSH 构建与前端脚本语法检查通过，完整命令、stdout、stderr、退出码和源哈希见 `.redtrace/verification/multistage/VERIFICATION.txt`。新增本地 SSH PTY 夹具验证跨 Run fencing 交接、旧 token 拒绝及租约失败清理；SFTP 夹具验证二进制/空文件/Unicode、默认不覆盖、stat/hash/list/read/move/delete、断点前缀续传、受控 Artifact 下载，以及 Worker A 下载生成的 File Resource 被 Worker B 复用上传。夹具不访问远程目标，不代表真实操作系统/SFTP 服务兼容性。浏览器场景未做渲染验收。用户要求暂不进行真实靶场测试，因此真实 SSH/SFTP、Windows、PTY、TUN、多跳环境与配对成功率测量尚未完成。没有测量数据，不声明 Agent 成功率已提升，也不将本地协议夹具描述成实际题目完成。

管理 API 的身份隔离仍是发布前置条件；项目授权记录不是网络沙箱。保持人工控制，不接通无人监督的自主多阶段攻击、自动入口部署或横向移动链条。可继续交付隔离靶场内的良性分阶段任务、执行正确性、人工接管与恢复验证。

## 继续执行顺序

1. 完成回归与对照证据后，继续补齐有向路径图、授权撤销及资源依赖失效传播、自动恢复与协议契约等本地可实现项。
2. 只有用户重新允许真实测试后，才在隔离靶场内验证 SSH/SFTP/PTY、Windows 文件语义、TUN 与多跳路径；未通过验证的 Provider 不自动派发。
3. 补齐其余 P0/P1 后建立固定题目快照、相同模型/Worker/时间/Token 预算的配对评测；每次恢复环境，报告完成率和置信区间，而不是给出未经测量的提升结论。
