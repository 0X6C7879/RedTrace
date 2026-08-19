---
name: tool-bootstrap
description: Missing tool installation workflow — find equivalents, verify OS/arch, install to managed tools directory.
---

# Tool Bootstrap

工具缺失时的安装流程。仅在需要新工具时加载。

## 流程

1. 先寻找已安装的等价工具并核验 OS/architecture
2. 依据官方文档安装
3. 固定版本、非交互方式
4. 安装到 `$REDTRACE_TOOLS_DIR`
5. 入口放入 `$REDTRACE_TOOLS_BIN`
6. 禁止写系统目录或修改 shell rc 文件
7. 如有公开 checksum 则校验
8. 运行 `--version` 和最小 smoke check
9. 最多尝试一个有依据的 fallback
10. 失败后继续推进，不得循环或阻塞
