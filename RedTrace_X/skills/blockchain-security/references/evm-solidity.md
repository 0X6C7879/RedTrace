# EVM / Solidity 特有语义

只写 EVM / Solidity 特有问题，通用漏洞分类见 `vulnerability-taxonomy.md`，DeFi invariant 见 `defi-invariants.md`。

## delegatecall

- delegatecall 在 **caller 的 storage 上下文**执行 callee 代码。
- 风险：可控/不可信的 implementation、storage 布局不匹配导致覆盖关键槽位。
- 检查：`delegatecall` 目标是否可被修改、返回值是否检查、selector 是否受控。

## Storage layout

- 变量按声明顺序占用 slot，升级合约 slot 顺序/类型必须兼容。
- 继承中父合约变量先占 slot，子合约新增变量追加。
- 检查：升级前后是否插入/重排变量（storage collision）；是否用 `constant`/`immutable` 正确。

## Proxy

- transparent / UUPS / beacon 三种模式。
- 关键槽位：implementation（EIP-1967 slot）、admin、beacon。
- 检查：initializer 是否可重放、implementation 是否可自毁、admin 权限是否收紧。

## msg.sender / tx.origin

- `msg.sender`：直接调用者（合约或 EOA）。
- `tx.origin`：发起交易的 EOA，**不可用于鉴权**（会被中间合约钓鱼）。
- 检查：权限判断是否用错；跨合约调用中身份是否被替换。

## CREATE2

- 可预测地址部署：`keccak256(0xff ++ creator ++ salt ++ keccak256(init_code))`。
- 风险：预知地址后向其中转入资产再被恶意合约接管；同地址不同 init_code 的 redeploy。
- 检查：部署后是否校验 `code.length`、salt 是否可被攻击者预测/复用。

## selfdestruct（当前语义）

- 自 EIP-6780 后，`selfdestruct` 仅在同交易创建合约时删除代码，否则只转走余额。
- 历史风险（旧链/旧编译器）：向任意地址强转 ETH、绕过余额检查。
- 检查：协议是否依赖 `address(this).balance` 且被 selfdestruct 强转绕过。

## ERC20 / ERC721 / ERC1155 callback

- ERC777 `tokensReceived`、ERC721 `onERC721Received`、ERC1155 `onERC1155Received` 都会回调。
- 风险：在内部 accounting 完成前触发回调 → 跨函数 reentrancy。
- ERC20 陷阱：USDT 等不返回 `true`（return-value assumptions）、fee-on-transfer（转入少于参数）。

## ERC4626

- shares/assets 兑换：`convertToShares`/`convertToAssets` 的取整方向。
- first depositor / donation 攻击（见 `defi-invariants.md` Vault 一节）。
- `totalAssets` 是内部记账还是 `balanceOf(this)`（donation 攻击面）。

## permit / EIP-2612

- permit 的 `owner`/`spender`/`value`/`deadline` 是否都纳入签名且被校验。
- `ecrecover` 返回 0 地址、`v` 未限 27/28。
- EIP-712 domain separator 是否绑定 chainId + verifyingContract + name/version。

## EVM call semantics

- 裸 `call` 不 revert，返回 `(bool, bytes)`，必须检查返回值。
- `transfer`/`send` 固定 2300 gas，且可因 gas 成本变化失败（依赖它们会 DoS）。
- `staticcall` 只读，用于避免重入但需注意 read-only reentrancy（读中间态）。

## gas / revert / fallback

- fallback/receive 的 gas 限制与逻辑（receive 仅 `msg.data == ""`）。
- 循环中 gas 耗尽导致 DoS；refund 逻辑错误。
- 依赖 `transfer` 的提款可能因接收方 fallback 耗 gas 而永久失败。

## calldata / memory / storage

- 未初始化 storage 变量、memory 与 storage 别名（同函数内 storage 指针别名写脏数据）。
- calldata 数组越界、动态数组长度未校验。
- 结构体在 storage 的 packed 布局与升级兼容。

## unchecked return behavior

- 编译器版本相关：Solidity <0.8 算术溢出不 revert。
- `unchecked {}` 块内溢出被利用（如 fee 计算）。
- `unchecked` 用于节省 gas 时，检查被绕过的边界是否安全。
