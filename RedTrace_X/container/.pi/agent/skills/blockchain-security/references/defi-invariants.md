# DeFi Invariant 专项

吸收 QuillShield 的核心优势：state invariant、semantic guard、accounting consistency、asset conservation、cross-contract state transition、oracle dependency、flash-loan assisted manipulation、adversarial transaction sequence。

对每个协议类型，先写下"必须永远成立的不变量"，再寻找破坏它的交易序列。

---

## Vault（含 ERC4626）

不变量：
- `totalAssets >= Σ 用户可赎回资产`（asset conservation）。
- `shares` 与 `assets` 的兑换关系正确且单调。
- 用户不能提取超过自身权益。
- harvest / yield 不能稀释或凭空增加他人份额。

重点攻击：
- **first depositor / donation**：先 deposit 极小份额获得 1 wei share，直接转账抬高 `totalAssets`，后续用户份额被取整吃掉。
- **rounding**：`convertToShares`/`convertToAssets` 取整方向错误 → 免费 mint/burn。
- **harvest 对称性**：`deposit → harvest → withdraw` vs `harvest → deposit → withdraw` 是否对称；`totalAssets` 与 `shares` 更新路径是否一致。
- **donation 攻击面**：`totalAssets = balanceOf(this)` 而非内部记账。

## Lending

不变量：
- 债务不能在没有偿还/清算时消失。
- `collateral * price >= debt * liquidationThreshold` 恒成立（健康因子）。
- 利息累积正确，坏账有明确销账路径。
- 清算不亏损协议、不超额奖励清算人。

重点攻击：
- **oracle 依赖**：清算价/借贷额度用 spot price → 操纵价格触发错误清算或超借。
- **bad debt**：价格骤跌导致坏账，谁承担？清算激励不足。
- **interest accrual**：`accrueInterest` 未在每次操作前调用 → 陈旧利率被利用。
- **collateral/debt 双记账**：deposit 与 borrow 状态更新不同步。

## AMM / DEX

不变量：
- 恒定积 / reserve consistency：`x * y = k`（扣除手续费后只增不减）。
- LP accounting：LP token 与 reserve 比例一致。
- fee accounting：手续费不重复计、不遗漏。

重点攻击：
- **reserve 与真实余额不一致**：捐赠直接改 `balanceOf` 而 reserve 不更新。
- **spot price**：用 `getReserves` 定价 → 操纵成本 < 可套利/可借资产价值。
- **LP 稀释**：首笔流动性 + 捐赠。
- **fee-on-transfer token**：转入 token 有手续费但按全量记账。

## Oracle

不变量：
- 价格来自可信、难操纵的来源。
- freshness / heartbeat 校验，stale price 不参与结算。
- 多源/fallback 一致性，decimal 统一。

重点攻击：
- **spot price / 无 TWAP**。
- **stale price**：喂价停止更新但协议仍用旧价。
- **manipulation cost**：操纵成本是否低于可获利（flash loan 使成本趋零）。
- **decimal mismatch**：8 位 vs 18 位混用导致数量级错误。
- **fallback oracle**：主 oracle 失效切到可操纵的备用源。

## Staking

不变量：
- reward 与质押时长/份额成正比，不能重复领取。
- unstake 不拿走未结算的他人奖励。
- epoch 边界奖励结算一致。

重点攻击：
- **reward debt**：`rewardDebt` 未更新 → 重复领取。
- **unstake 与 reward 结算顺序**：先 unstake 再结算造成份额错配。
- **epoch boundary**：跨 epoch 的份额快照被操纵。

## Governance

不变量：
- 投票权与真实持仓/锁仓一致。
- 提案执行幂等、时间锁有效。
- 不能瞬时借投票权通过恶意提案。

重点攻击：
- **flash-borrow governance**：闪贷借入治理 token 投票。
- **delegation / snapshot**：投票快照时点与持仓错配。
- **timelock 参数**：delay 过短、提案可重入。

## Bridge

不变量：
- 一条源链消息唯一对应一次目标链 mint/unlock（message uniqueness）。
- 目标链只信任经过验证的源链证明。
- burn/lock 与 mint/unlock 严格配对。

重点攻击：
- **message forgery / replay**。
- **proof verification** 缺陷（Merkle/签名/relayer）。
- **nonce/sequence** 错位、乱序。
- **mint/unlock inconsistency**：源链未 lock 但目标链 mint。

---

## 通用推演格式

```text
Transaction A → State X → Transaction B → State Y → Invariant Broken
```

优先构造**多步骤、跨函数、跨合约**序列，而不是单函数内的显式 bug。一个不变量通常对应一组可泛化攻击模式（见 `case-patterns.md`）。
