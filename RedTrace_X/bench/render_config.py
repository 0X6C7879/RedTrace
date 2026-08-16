#!/usr/bin/env python3
"""校验必需环境变量后把 redtrace.yaml.template 原样复制为 redtrace.yaml。

只读三项由测评平台下发的机密：BENCHMARK_TOKEN / BENCHMARK_BASE_URL / API_KEY。
其余常量（模型名、网关地址、VPN 探针）已在模板里写死，benchctl 内部也带 VPN 默认值。
redtrace.yaml 本身不含任何明文或引用，可随镜像/代码提交而不泄密。
"""

from __future__ import annotations

import os
import shutil
import sys


# 这三项是平台下发、运行时必须存在于调度进程环境中的唯一敏感值；
# 缺失即提前失败（fail-fast），与旧版行为一致但范围收窄到这三项。
REQUIRED_ENV_VARS = (
    "API_KEY",
    "BENCHMARK_TOKEN",
    "BENCHMARK_BASE_URL",
)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: render_config.py <template> <output>", file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    missing = sorted(v for v in REQUIRED_ENV_VARS if v not in os.environ)
    if missing:
        print(
            "error: 缺少平台下发机密: " + ", ".join(missing),
            file=sys.stderr,
        )
        print("请在启动前通过环境变量导出(交互式 export 或容器启动注入)", file=sys.stderr)
        return 1
    # 原样复制——redtrace.yaml 不含任何明文密钥或占位引用。
    shutil.copyfile(src, dst)
    print(f"wrote {dst} (no secret substitution)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
