# TPCTF 2026 × RedTrace Skill

**目标**：仅通过安装共享 Skill，让 RedTrace Worker 调用 CTFy REST API 和 WireGuard，Commander 沿用原有 FGS/任务调度来完成授权竞赛解题。包不更改 RedTrace 核心代码，也不包含自动漏洞利用器。

## 1. 安装（RedTrace 仓库根目录）

将压缩包中的 `tpctf-api/` 整个目录解压到 `<RedTrace仓库>/skills/tpctf-api/`，保持目录：

```
RedTrace/
  skills/
    tpctf-api/
      SKILL.md
      scripts/tpctf.py
      references/...
      examples/START_TASK.md
```

在 RedTrace 的 Skill 管理界面确认已识别 `tpctf-api`；若运行中未刷新，新建 Worker 会话或重启 RedTrace。这里使用仓库公开 README 的一级共享 `skills/` 规则；如果你的本地 RedTrace 分支有自定义 Skill 目录，应以当前分支加载器的实际目录为准。

## 2. 先配置环境变量

RedTrace 的 `redtrace.yaml` 已提供 `common_env` 用于传递环境变量给 Worker（公共仓库 README 中有说明）。把下面的变量**添加或合并**到现有 `common_env` 下，不要覆盖其他配置：

```yaml
common_env:
  CTFY_BASE_URL: "https://ctfy.tsinghua.edu.cn/api/v1"
  CTFY_PLAY_TOKEN: "pf_从官方平台创建的agent_play令牌"
  # 若需出题测试，再设置：
  # CTFY_AUTHOR_TOKEN: "pf_从官方平台创建的agent_author令牌"
  # 自动识别比赛有歧义才设置：
  # CTFY_COMPETITION_ID: "平台返回的智能体赛道ID"
```

也可以给 RedTrace 进程的 OS 环境设置同名变量，但**必须确保 Worker 的 Shell 环境实际继承到它们**。不要在聊天提示词、仓库源代码和公开日志中粘贴真实令牌。`CTFY_BASE_URL`/`CTFY_PLAY_TOKEN` 是本包提供的变量约定，官方 HTTP 协议为 `Authorization: Bearer ...`。

**大模型配置单独处理**：入围赛使用 RedTrace 原有 `providers`/`workers` 配置调用自己的 DeepSeek、智谱等模型 API。入围赛无需官方模型网关；初选赛和正式赛须按照官方第 8 章切换平台网关。`OPENAI_BASE_URL`/`OPENAI_API_KEY` 与 CTFy 平台的 `CTFY_*` 不是一回事。

## 3. 安装依赖

- Python **3.10+**（本包只有 Python 标准库，无 `pip install`）。
- Linux / WSL / macOS：`wireguard-tools`（包括 `wg`、`wg-quick`）。
- 能在 RedTrace 执行 Worker 的命名空间运行 `wg-quick up/down` 的权限；如果需要无交互 sudo，可用 CLI 的 `--sudo`，但请在预先授权的竞赛环境按本机实际安全策略配置，不可依靠交互密码提示。
- Web/Pwn 等解题工具沿用 RedTrace 已装的专业工具。

如果使用 Docker，请保证 VPN 及其必要内核权限在**实际运行 Agent 工具**的容器/网络命名空间可用；不能只检查宿主机 WireGuard 连接。

## 4. 自检

在 RedTrace 仓库根目录：

```bash
python3 skills/tpctf-api/scripts/tpctf.py doctor --online
python3 skills/tpctf-api/scripts/tpctf.py competitions --registered
python3 skills/tpctf-api/scripts/tpctf.py challenges --unsolved
```

**正式开赛前**题目清单可能为空，`start` 会返回 `competition_not_started`，不能伪造开机成功。

## 5. 真正启动 RedTrace

照常启动 RedTrace，**创建或使用一个比赛 Project**，将 `examples/START_TASK.md` 的正文作为任务/Commander 指令。**这里不是启动一个独立的自动解题进程**：Skill 提供 RedTrace 可调用的 API/命令，由 RedTrace 自己的 Commander/Worker 对当前题目自主执行和提交。

人工只需提供一次比赛任务；后续能否持续无人值守取决于本地 RedTrace 版本的 Commander 是否持续调度。官方明令的自主性与操作权限仍须遵守。

## 6. CLI 帮助

```bash
python3 skills/tpctf-api/scripts/tpctf.py --help
python3 skills/tpctf-api/scripts/tpctf.py author --help
python3 skills/tpctf-api/scripts/tpctf.py vpn --help
```

常用命令见 `SKILL.md`。所有 API 返回 JSON，HTTP 异常也输出结构化 `code` + `detail`；除 VPN 配置私钥被写入 chmod 600 的本机临时配置文件外，不持久化平台令牌/Flag。不要收集 stdout 中的真实 Flag 到公开日志。

## 7. 已知限制与事实边界

1. **没有真实 API Token，不能对官方线上接口执行端到端测试**。提供的 `tests/` 是离线模拟测试。
2. **Skill 本身不会取代 RedTrace Agent，也不会自动破解 CTF**；现有 Worker 必须可以调用 Shell/本地 Python。
3. 入围赛全队只有 **1 个靶机实例槽位**。CLI 按实际平台 429 限制处理；多个独立机器上的 CLI 没有跨机分布式锁，必须由 Commander 统一协调。
4. VPN 脚本约定本机接口名为 `tpctf0`，为了避免乱序重连，同一执行命名空间仅处理一份当前实例的 WireGuard 配置。该文件保存在 `${CTFY_STATE_DIR:-~/.cache/redtrace-tpctf}/tpctf0.conf`，仅本机私有可读。连接失败后也不要直接把配置内容公开。
5. API 文档中的 `GET /instances/{id}/vpn-config` 是通过正式接口文档第 9.1 节指定的，仍应以比赛平台真实 OpenAPI 更新为准。
6. 附件内容 URL 的具体形状不在所附文档中明确，CLI 在 `detail` 返回 `attachments[]`，由 Worker 根据实际 URL 下载，不假设附件必须走哪一条未经文档证实的 API。

## 文件依据

- CCF-TPCTF 赛事规则手册 v2.6（2026-11-13），尤其第 2–4、7–8 页。
- TPCTF 2026 参赛接口文档 v1.0（2026-11-13），尤其第 3–5、10–14、16–27 页。
