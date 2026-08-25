# Move 特有语义

只写 Sui Move / Aptos Move 特有差异项，通用分类见 `vulnerability-taxonomy.md`。

## Object ownership（Sui）

- 对象有 owner：address-owned、shared、immutable。
- 检查：`shared` 对象（供任何人操作）上的关键逻辑是否有访问控制；`immutable` 对象是否真的不该改；address-owned 对象能否被错误转移/销毁。

## Resource semantics

- Move 资源是线性类型：不能被复制、不能被隐式丢弃（必须显式 `move` / `unpack` / `destroy`）。
- 检查：资源是否被 `copy`/`drop` 误用导致凭空复制或丢失；`key` ability 的对象是否可被任意 `transfer`。

## Capability model

- `Capability` / `Cap` / `AdminCap` 是权限凭证对象。
- 检查：capability 是否可被非授权方获取、复制、转移；初始化时 cap 是否发给错误地址；cap 是否被遗忘导致永久锁死或遗留后门。

## Shared objects（Sui）

- 共享对象所有交易可访问，排序由共识决定。
- 检查：共享对象上的 `entry` 函数是否有权限校验；是否存在同交易内读写竞态（Sui 事务原子性 vs 跨交易竞态）。

## Signer

- `signer` 是特殊类型，只能由 `entry` 函数参数传入，无法凭空构造。
- 检查：是否用 `signer` 做鉴权（`tx_context::sender` vs signer 混淆）；signer 是否被传入错误的接收者地址。

## Type safety boundary

- 泛型 `phantom` 类型参数、`Coin<CoinType>` 的 coin type 伪造。
- 检查：`Coin<T>` 的 `T` 是否被校验（恶意代币冒充协议代币）；`fungible asset` 类型混淆。

## Aptos / Sui 差异

- Aptos：账户全局状态、`resource account`、`coin` 模块、`aptos_framework`；签名者能力由 entry 函数决定。
- Sui：对象模型、`Coin<T>` + `Balance<T>`、`dynamic field`、`package upgrade`（`UpgradeCap`）。
- 共同风险：包升级权限（Aptos `UpgradeCap` / Sui `UpgradeCap`）是否可被滥用；升级后存储兼容。

## 其他

- `dynamic_field` / `dynamic_object_field` 的 key 碰撞与类型安全。
- 时间戳（Sui `Clock`、Aptos `Timestamp`）用于结算时的可操纵性。
- `entry` vs `public` 函数可见性与调用限制。
- 算术：Move 默认溢出检查，但 `unchecked`（Aptos）/ 位移边界仍需注意。
