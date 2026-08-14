#!/usr/bin/env python3
"""用环境变量渲染 redtrace.yaml.template → redtrace.yaml。"""

from __future__ import annotations

import os
import sys
from string import Template


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: render_config.py <template> <output>", file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    template = Template(open(src, encoding="utf-8").read())
    missing = sorted(name for name in template.get_identifiers() if name not in os.environ)
    if missing:
        print("error: 缺少环境变量: " + ", ".join(missing), file=sys.stderr)
        print("请在 RedTrace_X/.env 中填写后重试（参考 .env.example）", file=sys.stderr)
        return 1
    with open(dst, "w", encoding="utf-8") as handle:
        handle.write(template.substitute(os.environ))
    print(f"rendered {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
