# CTFy × RedTrace Skill

用于 https://ctfy.tsinghua.edu.cn/ 的比赛、练习场和测评集，不再专指 TPCTF。

## 使用

本 Skill 的标准目录是 `skills/ctfy-api/`。仓库保留 `skills/tpctf-api` 到此目录的兼容符号链接，以及旧脚本名 `scripts/tpctf.py`，供现有 Benchmark 调用；不是两份 Skill。只修改 Skill 文件，不修改引擎、调度器或用户 MCP 配置。

已连接 `ctfy` MCP 时按 `SKILL.md` 直接调用官方工具。Claude `claude mcp add --scope user ...` 只配置 Claude，不会给 RedTrace Worker 自动增加 MCP 或环境变量。未连接 MCP 时可使用本 Skill 的标准库 CLI，通过 `/api/v1/mcp/` 调用同一平台。

Worker 环境变量（通过已有 `common_env` 或实际继承的进程环境传入，不要覆盖其他配置）：

- `CTFY_TOKEN`：平台 Bearer Token；不写入源代码或提示词。
- `CTFY_PLAY_TOKEN` / `CTFY_AUTHOR_TOKEN`：保留旧专用 Token 配置，优先于 `CTFY_TOKEN`，权限由平台判断。
- `CTFY_BASE_URL`：默认 `https://ctfy.tsinghua.edu.cn/api/v1`，不是网站首页，也不是带 `/mcp/` 的地址。
- `CTFY_COMPETITION_ID`：仅手动 CLI 或兼容旧配置时使用的可选默认 ID。RedTrace Commander 通过原生 `legion_platform_list` 获取候选并传 `competition_id`，自动保存到当前 Project；多个 Project 互不覆盖，不需要用户到网页查找 ID。

```bash
python3 skills/ctfy-api/scripts/tpctf.py doctor --online
python3 skills/ctfy-api/scripts/tpctf.py mcp tools
python3 skills/ctfy-api/scripts/tpctf.py competitions --registered
python3 skills/ctfy-api/scripts/tpctf.py challenges --competition <competition_id> --unsolved
```

Python >=3.10，无第三方依赖。WireGuard 仅 VPN 题需要；CLI 的 VPN 辅助命令需要 `wg` / `wg-quick`，不安装软件、不自动授予权限。MCP 工具可能返回实例凭据或附件内容，不要公开原始输出。

## 验证

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s skills/ctfy-api/tests -v
```

离线测试不访问网站。此次另使用用户授权的 Token 实测了线上 REST/MCP 读取和练习场实例生命周期，未进行真实赛事解题、Flag 提交或 VPN 连接；详情见本次修复的外部验证记录，而非将离线通过等同真实 Benchmark 通过。

`MANIFEST.sha256.json` 记录本包内容哈希，不包含运行时缓存和 `.redtrace.json` 状态。
