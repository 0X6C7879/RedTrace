# Benchmark Packs

可拔插 Benchmark 接入目录，与 RedTrace 核心完全隔离。删除本目录即完全移除 Benchmark 能力。

## 快速开始（以 tsec 为例）

```bash
# 1. 填写凭证
cp benchpacks/tsec/config.example.toml benchpacks/tsec/config.local.toml
#    编辑 config.local.toml：platform.base_url / platform.token

# 2. 准备 Pack（独立 venv + SDK + Capability Overlay + compose.override）
uv run --no-project benchpacks/benchctl.py prepare tsec

# 3. 检查
uv run --no-project benchpacks/benchctl.py doctor tsec

# 4. 跑分
uv run --no-project benchpacks/benchctl.py run tsec --mode local --dispatch redtrace.yaml

# 状态 / 恢复 / 停止 / 关闭平台容器
uv run --no-project benchpacks/benchctl.py status tsec
uv run --no-project benchpacks/benchctl.py resume tsec
uv run --no-project benchpacks/benchctl.py stop tsec
uv run --no-project benchpacks/benchctl.py close-all tsec

# Agent 单题操作
uv run --no-project benchpacks/benchctl.py task list tsec
uv run --no-project benchpacks/benchctl.py task submit tsec <task-id> 'flag{...}'
```

## Docker 模式

不修改原始 `docker-compose.yaml`，使用 prepare 生成的 override：

```bash
docker compose -f docker-compose.yaml \
  -f benchpacks/.runtime/tsec/compose.override.yaml up -d
```

## 目录约定

- `benchpacks/<pack>/`：Pack 本体（pack.toml、config、adapter.py、SKILL.md）
- `benchpacks/.runtime/<pack>/`：venv、uv 缓存、Capability Overlay、state.json、compose.override.yaml
- `benchpacks/results/<pack>/<run_id>/`：每次跑分的结果
- Token 仅存在于 `config.local.toml`，不进入 RedTrace 数据库、日志与结果
