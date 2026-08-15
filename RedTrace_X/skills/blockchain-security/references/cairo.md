# Cairo / Starknet 特有语义

只写 Cairo / Starknet 特有差异项，通用分类见 `vulnerability-taxonomy.md`。

## felt / integer semantics

- Cairo 字段元素（felt252）不是定长整数：模一个素数，取值不是 2^N。
- 检查：比较/边界判断是否误用；`felt` 与 `u256`/`u128` 混用时的截断与溢出方向；`try_into`/`unwrap` 边界。

## Storage

- 合约存储是 key→felt 映射；复杂类型需 `LegacyMap` / `Map` 和派生。
- 检查：storage slot 计算、复杂变量序列化/反序列化是否一致；升级后存储布局兼容。

## Account abstraction（原生）

- Starknet 所有账户都是合约账户，交易由账户合约 `__execute__`/`__validate__` 处理。
- 检查：`__validate__` 是否只做验证（不写状态）；`__execute__` 的调用者/入口权限；signature 验证（`is_valid_signature`）；nonce 与 replay 防护。

## L1/L2 messaging

- Starknet ↔ Ethereum 消息（`L1Handler` / `send_message_to_l1`）。
- 检查：消息来源/目标校验、nonce/序列号、重放、`from_address` 伪造。

## Starknet authorization

- `get_caller_address`、`get_contract_address`、`syscall` 的调用者身份。
- 检查：权限判断是否用错 caller；跨合约调用中身份替换。

## Cairo-specific edge cases

- `assert`/`panic` 语义、`revert` 条件。
- 算术：`Add`/`Mul` 溢出在 felt 域内的处理；`u256` 溢出。
- `component`/`impl` 系统的访问控制拆分。
- 递归调用与 gas（Starknet 的步骤/资源计量）。
- 升级：`replace_class_syscall`、proxy 模式的 initializer 重放。
