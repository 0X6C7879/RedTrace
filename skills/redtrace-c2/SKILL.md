---
name: redtrace-c2
description: C2 Listener, Session, Payload lifecycle — reverse shell, bind shell, external C2, and session management.
---

# RedTrace C2

C2 工作流。仅在需要 reverse/bind shell 或 C2 时加载。

## Listener

- `redtrace-resource listener-create` — 创建 TCP reverse listener
- Bind Shell: `redtrace-resource listener-create --listener-type tcp_bind --target-host <target>`

## Session

- 任何获得的 shell 必须立刻用 `session-register` 登记
- reverse shell: `session-register --connection-type reverse --listener <listener_id>`
- external C2: `session-register --connection-type external_c2`

## Payload

- `redtrace-resource payload-oneliner` — 一行 payload
- `redtrace-resource payload-build` — 构建 Beacon
- `redtrace-resource payload-external` — MSF/Sliver/Cobalt Strike Adapter
- `redtrace-resource payload-import` — 导入 Worker 生成的 payload

## Resource ID

- 最终结论提到 shell/session 时必须包含 Resource ID
