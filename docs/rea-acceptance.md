# REA 集成验收（2026-10-11，macOS ARM64）

实现说明见 [rea-integration.md](rea-integration.md)。数据为本次实际执行，
不是 REA 上游宣传或 Mock 结果。

## 固定版本

- RedTrace 起点 main：`e25e25f54b99ba3d62bbbb153f6a5e0659a0f369`，与 origin/main 一致。
- REA npm：`6.4.0`，npm ci 锁定依赖；npm audit 0 vulnerabilities。
- REA 上游审阅提交：`951c2aae3be1c357df9f23558d8c09680e64c2cb`。
- DSH：现有定制 `0.2.1-alpha.2`；不改上下文压缩或 MCP 通信实现。
- Node：`24.21.0`；Ghidra：`12.1.3`；Java：现有 OpenJDK 21。
- 官方 Skill：7 个文件（SKILL.md + 6 个 references），逐字节对照 npm 包。
- 托管样本为上游 ManagedPe.fixture.ts 生成的合成 PE，4096 字节，SHA256
  `d3cee22388eadc9de6ee91fccea2ef4e50b151e002e752b5b5e19e189c32b887`；
  它只验证解析接口，不是现实 .NET 应用或 ILSpy 反编译验收。

## 测试结果

| 实际命令 / 验收 | 结果 |
|---|---|
| `npm ci` | 成功，147 packages；未做 Docker 构建 |
| `npm run dsh:build` | 原生底层、上游 host 和 RedTrace adapter 全部构建成功 |
| `npm --prefix packages/redtrace-engine run check` | TypeScript 检查成功 |
| `npm --prefix packages/redtrace-engine test` | 140 tests，134 pass，6 skip，0 fail |
| `node --test packages/redtrace-dsh/test/*.test.mjs` | 50 tests，49 pass，1 skip，0 fail；跳过单独 opt-in 的 Ghidra 测试 |
| `REDTRACE_REA_REAL_TESTS=1 node --test packages/redtrace-dsh/test/reverse.test.mjs` | 6 tests，6 pass，0 skip/fail |
| 隔离的真实 Cordis 服务（127.0.0.1:18080） | 插件列表 / 启用 / 停用 / 再启用 HTTP 200；重启后 running 状态持久化 |
| 真实 DSH scoped ToolRuntime | Skill 加载触发官方 MCP，Run 隔离，按需增量可见性、停止后 Schema 消失 |
| 真实 JS 分析 | 自建 source tree 的 summary Evidence，原生 Worker 分析成功 |
| 真实托管静态解析 | 合成 PE/CLI 元数据和 Oracle/Answer 成员解析成功，不执行目标 |
| 真实 REA CLI | capabilities；另行 inspect-managed-artifact 成功 |
| 真实 Ghidra | 已知返回 42 的 PE/ELF，反编译成功，两次查询复用同一 Java PID |
| 生命周期 | 显式取消、上游 1ms 冷启动 deadline、分析中停用均返回失败而非伪成功；MCP/Java 进程清理为 0 |
| Evidence | 大结果有界、内容寻址去重，显式导出 bundle 停用后仍存在；临时资源清理 |
| `git diff --check` / `bash -n build-dsh.sh` | 成功 |

隔离服务使用 mock Worker 路由，仅用于真实服务和管理 API 启停验收；
这不是真实模型解题或平台分数验收。REA/Ghidra 测试确实连接真实引擎。

## Token / 资源量化

统计模型实际可见的 DSH ToolRuntime.schemas，不是执行黑名单：

| 状态 | REA 工具数 | 序列化 Schema 字节（含工具描述） |
|---|---:|---:|
| 停用 | 0 | 0 |
| 启用但未加载 Skill | 0 | 0 |
| Skill 首次加载后的入口集合 | 14 | 17,999 |
| 扩展全部官方工具，compact | 170 | 254,673 |
| 直接完整目录，full | 170 | 436,594 |

`reverse_tools` 是额外的一个小型生命周期控制 Schema，不计入官方工具数。
首次入口集合比完整 full 目录减少 **95.88%** Schema 字节；相同完整目录
compact 比 full 减少 **41.67%**。最大的 compact parameters 为 **11,026**
字节，低于上游 13 KiB 预算。对全部工具的官方示例与负例共 **736** 次
Ajv 校验，compact / full 结果一致。这里测的是 Schema 字节，不是模型
Tokenizer 实际计费 Token；尚未做每个外部模型 API 的兼容性在线验收。

超过 8 KiB 的 binary_session 结果实际投影为 **2,025 字节**，完整文本
保留在权限受限的文件并去重。小样本 PE 冷启动加两次查询约 **10 秒**，
ELF 约 **5.7 秒**；第二次普通函数查询在 REA 日志中约 **2–3 ms**。
不同重复运行受构建/并发负载影响；不把这些样本时延推广成任意二进制的 SLA。
每个活动目标观察到 **1** 个 Ghidra Java 进程；启用未用、关闭目标、取消、
插件停用后均无受管 Java 进程。没有量化 RSS/CPU 对比或宣称通用性能增益。

## 未验证与保留

- EVM：上游当前 offline profile 限 Linux x64；本机 macOS 实际返回
  `capability_unavailable`，验证的是边界错误而不是 EVM 分析成功。
- 未配置 Hopper/IDA/JEB/JADX/ILSpy；未提供 Android 设备、真实 APK、固件、
  GUI 授权场景、NativeAOT 样本或商业许可证。对应工具入口全部保留，但
  不宣称真实 Provider 验收通过；JEB 缺依赖结构化错误实际验证。
- 没有实际模型端到端自主解题、在线平台 `correct=true` 或历史分数对照。
  不把接口/单元测试等同于“不降低所有原有解题能力”的测评分数证明。
- Windows/Linux 的真实完整引擎流程未在本机运行。三平台 CI 已增加锁定
  REA 的安装与原生 MCP 测试；Windows launch 脚本修改只做代码检查。
- 旧 ghidra-headless 批量导出和特殊平台覆盖未证明完全等价，全部脚本保留。
  Radare2/Rizin 与 GDB/angr/Z3/Unicorn/Frida/pwntools 也保留。仅移除旧 Skill
  中重复的安装说明和基础工具命令，不删除有效 CTF reference 文件。
