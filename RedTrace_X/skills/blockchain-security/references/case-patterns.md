# 可泛化攻击模式

只存**可泛化的攻击模式**，不存 CVE / 项目事实堆积。每条模式描述"什么结构 → 优先测什么 → 为什么"。这些模式未来可配合 `redtrace-skill learn blockchain-security` 持续沉淀（沉淀规则见 SKILL.md 与 RedTrace Learning 集成约定）。

## Accounting / Share

- 当 Vault 的 share accounting 与 yield realization 分属不同状态更新路径时，优先测 `deposit → harvest → withdraw` 与 `harvest → deposit → withdraw` 是否产生状态不对称。
- 当 `totalAssets` 直接用 `balanceOf(address(this))` 而非内部记账时，测 donation 攻击（直接转账抬高分母）。
- 当 share 兑换含整数除法时，逐方向核对取整：`shares → assets` 与 `assets → shares` 是否都能免费 mint/burn 1 wei。
- 当首笔存款可指定极小金额时，测 first-depositor 通胀：deposit 1 wei → 捐赠 → 后续份额被取整吃掉。

## Reentrancy / Callback

- 当外部 callback 可在内部 accounting 完成前触发时，检查**跨函数** reentrancy，而不仅是同函数重入。
- 当合约在状态更新前调用 `transferFrom`/mint/外部 token 时，测恶意 token 回调（ERC777/ERC721/ERC1155）。
- 当裸 `call` 返回值未检查、或 `send`/`transfer` 被依赖时，测提款永久失败 / 静默失败。

## Oracle / Price

- 当协议直接使用 AMM spot price 时，计算操纵成本是否低于可借取/可套利资产价值。
- 当价格无 freshness/heartbeat 校验时，测 stale price 结算。
- 当 oracle decimal 未统一（8 vs 18）时，测数量级错乱。
- 当存在 fallback oracle 时，测主源失效后切到可操纵备用源。

## Flash Loan / Economic

- 当协议在单交易内允许借入+投票/借入+清算时，测 flash-loan 辅助操纵（价格/治理/清算）。
- 当清算激励或坏账承担方不明时，测价格骤跌后协议是否被迫承担坏账。

## Signature / Auth

- 当签名验证用 `ecrecover` 未校验 0 地址 / 未绑 chainId+contract 时，测 replay（同链跨交易、跨链）。
- 当 `tx.origin` 被用于鉴权时，测中间合约钓鱼。

## Upgrade / Proxy

- 当 proxy 的 `initialize` 无 `onlyInitializing` / 可重放时，测 implementation 抢占。
- 当 implementation 可自毁或 delegatecall 目标可被修改时，测 implementation takeover。

## Cross-chain / Bridge

- 当 bridge 消息只依赖 relayer 签名而未做来源链证明时，测消息伪造。
- 当 nonce/sequence 无 gap 检查或可乱序时，测重放 / 乱序 mint。
- 当源链 burn/lock 与目标链 mint/unlock 分开记账时，测不一致（凭空 mint 或资产滞留）。

## 通用推演

每个模式落到同一格式：

```text
结构特征 → 交易序列 → 破坏的 invariant
```

沉淀新模式时要求：可复用、已验证、非项目专属、能提升未来区块链任务（不沉淀合约地址/私钥/target/未验证猜测/一次性 workaround）。
