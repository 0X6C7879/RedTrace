# TON / Cosmos / Substrate 差异项

只写这些链的差异项，通用漏洞分类见 `vulnerability-taxonomy.md`，不重复。

## TON（FunC / Tact / TVM）

- **消息模型**：合约是异步消息驱动的 actor；`msg.sender` 语义与 EVM 不同（外部消息 vs 内部消息）。
- **bounce**：消息 bounce 导致失败回退；检查 `bounce` 与余额处理，避免双花/资产滞留。
- **gas / 费用**：计算费用（compute fees）、存储费、转发费；检查 gas 耗尽与退款逻辑。
- **cell / slice / builder**：序列化结构，检查长度/边界、`load`/`preload` 越界。
- **`accept_message`**：未正确 accept 的消息可被重复处理。
- **时间戳**：`now` 用于结算时的可操纵性。
- **钱包/账户**：wallet v3/v4/v5 合约权限，owner 公钥校验。
- **可重入**：TON 无同步跨合约调用，但消息回调链仍有重入/状态中间态风险。

## Cosmos / CosmWasm

- **msg 序列化**：`InstantiateMsg` / `ExecuteMsg` / `QueryMsg` 反序列化边界与未知字段。
- **权限**：`info.sender` 鉴权；`cw-ownable` / `cw-control` 的 admin 转移。
- **余额**：`Balance`（原生币）与 `cw20`（代币）双轨；`deposit`/`withdraw` 记账一致性。
- **重入防护**：CosmWasm 无同步重入（无跨合约同步调用），但多消息/原子性组合仍有状态风险。
- **submessage / reply**：`ReplyOn` 模式与失败处理。
- **时间**：`env.block.time` 用于结算的可操纵性。
- **升级**：`migrate` 入口的存储兼容与权限。

## Substrate（FRAME / ink!）

- **pallet**：`call` 的 `origin` 权限（`ensure_signed` / `ensure_root`）；`Weight` 计量。
- **存储**：`StorageMap`/`StorageDoubleMap` 的 key 校验；`ValueQuery`/`OptionQuery`。
- **ink! 合约**：`ink::contract` 的 `env().caller()` 鉴权；storage 布局；`selector` 冲突。
- **跨合约调用**：`call` / `instantiate` 返回值处理与 gas。
- **时间戳**：`pallet_timestamp` 的 `now` 可操纵性（区块内可控范围）。
- **治理**：`pallet_democracy`/`pallet_collective` 的提案与投票。
