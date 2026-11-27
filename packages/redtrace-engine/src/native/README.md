# Native runtime projections

`projectAuditEvents` 接受 SQLite 返回的 UTF-8 JSON 字节缓冲数组，批量投影 Run Trace 摘要。Rust 从缓冲借用原始 JSON 字段，跳过工具参数，正文只复制前 180 个 UTF-16 code unit；大正文不进入 JS 字符串堆。每页只跨越一次 N-API 边界，返回小 JSON 数组供 TypeScript 解码。

输入来自 Store 以 `JSON.stringify` 保存的规范 Audit 对象。Rust 校验完整 JSON，保留缺失字段与 null 的区别，支持转义和孤立 surrogate，并精确匹配 JS `slice(0, 180)`。原始表、详情读取、搜索、分页和 Graph 所有权校验仍由 Engine 负责，持久化格式没有变化。

`compactToolTexts` 接受一次工具结果的全部文本块，用 UTF-16 code unit 比较相邻行；只在至少三行相同且严格缩短时折叠。未变化的块返回 null，调用方沿用原字符串。CRLF、NUL、孤立 surrogate 和重复次数与原 JS 算法一致。DSH 仍在折叠前通过原生 Spill 保存完整收到的输出，保留 PTC value、读取工具、非文本结果及会话隔离；归档失败仍按既有逻辑保留原文。

在项目根目录运行 `npm run native:build`；需要 Rust 1.88+ 和本机 C 链接器。Cargo.lock 锁定 Rust 依赖，N-API 8 保持支持的 Node 版本间 ABI 稳定。构建脚本校验产物后写入源码/平台指纹，源码变化才重新构建。Cargo 缓存默认在用户 `.cache/redtrace/cargo`（Windows 使用 LOCALAPPDATA/redtrace/cargo），可复用标准 `CARGO_TARGET_DIR`。原生库和指纹不入库，Rust 源码与 lockfile 入库。

启动器、Engine npm start/test、DSH 适配器构建和 Docker 均复用同一构建脚本。Docker 在独立阶段编译，运行镜像只保留 `.node` 文件。运行时按第一次 Trace 摘要或工具文本压缩请求加载该库；没有原生构建失败后的 JS 降级路径。本机构建通过同目录临时文件和原子 rename 发布，避免覆盖正在被进程映射的原生库 inode；已有进程仍保留原加载版本，新版本在下次启动加载。

验证：`cargo test --locked --manifest-path packages/redtrace-engine/src/native/Cargo.toml` 和 `node --test packages/redtrace-engine/test/native-audit.test.ts`。Node 差分回归覆盖空值、类型、600 组可包含孤立 surrogate 的确定性字符串、UTF-16 截断、转义和摘要之后的损坏 JSON；Engine 集成回归验证搜索、分页及完整详情保留。DSH 的 `spill.test.mjs` 对照原 JS 算法验证 UTF-16 行组和严格长度边界；`execution-tools.test.mjs` 验证实际终端、多个文本块、PTC value、会话隔离与逐字符原文留存。`npm run bench:output` 和 `npm run bench:agent -- --tool-output` 分别测量混合文本压缩与真实 Agent 命令输出路径，添加 `--original-output` 对照 Git `42d6b795` 中的原 JS 实现。
