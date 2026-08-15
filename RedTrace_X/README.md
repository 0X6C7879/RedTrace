# RedTrace_X：Cairn 基线的 Pi-only TSecBench 运行时

本目录已回归到 [oritera/Cairn](https://github.com/oritera/Cairn) `main` 的
`8f702c5f3f9d3163948bd4089edc73980c9c9484` 基线。生产 Worker 只保留 Pi：

- `pi-coordinator`：只运行 `Bootstrap` 和 `Reason`，并发上限 1。
- `pi-explore-1`、`pi-explore-2`、`pi-explore-3`：每个只运行 `Explore`，可同时执行 3 个 Intent。
- 四个 Worker 都使用 `https://agent-awd.baidu.com/v1/chat/completions` 和
  `glm-5.2-agent-chanllenge`；密钥只从 `API_KEY` 环境变量读取。

Claude Code、Codex、MCP、插件以及 RedTrace 的扩展控制面不在本基线中。`mock`
仅作为 Cairn 离线测试后端保留，不是可配置的生产模型 Worker。

## Pi 原生 Skills

Pi 从用户配置目录 `container/.pi/agent/skills/` 原生发现以下 7 个 Skill：

- `tsec-benchmark`
- `api-security`
- `browser-automation`
- `reverse-engineering`
- `pwn-chain`
- `llm-security`
- `blockchain-security`

运行时 `PI_CODING_AGENT_DIR` 指向 `container/.pi/agent`。适配器不再传入
`--no-skills`，但继续禁用扩展、提示模板、主题和额外上下文文件。

## 配置与启动

```bash
cp .env.example .env
# 填写 API_KEY 与 BENCHMARK_TOKEN
./start.sh
```

`start.sh` 会渲染 `dispatch.yaml`，启动 Cairn Server 和 Dispatcher，然后运行
`bench/benchctl.py run`。TSecBench 的目标、VPN 和生命周期逻辑仍由 `benchctl`
负责，Cairn 只负责任务图和并发调度。

## 当前阶段验证

```bash
uv run --project cairn --group dev pytest
python3 bench/selfcheck.py
uv run --project cairn cairn dispatch --config dispatch.yaml --startup-healthcheck-only
```

本阶段不构建 Docker 镜像。代码、配置、三路 Explore 并发和 Pi Skill 原生发现
全部验证通过后，再进入镜像制作与离线工具链验证。

## License

基础项目沿用 Cairn 的 GNU AGPLv3 许可，详见 `LICENSE`。
