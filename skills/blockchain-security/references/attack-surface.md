# 攻击面建模与入口分类

吸收 Trail of Bits building-secure-contracts / entry-point-analyzer 的"状态修改入口枚举 + 权限分类"方法，以及攻击面建模思路。

## 目标

把一个协议拆成可逐一攻破的入口集合，避免"整体看代码没有漏洞"的错觉。攻击面 = 所有能改变协议状态的入口 × 每个入口的权限/输入/资产效果。

## 枚举入口的方法

1. **按 ABI / 源码**：列出所有 `external` / `public` 函数。
2. **按回调**：`receive`、`fallback`、ERC721/1155 回调、Uniswap V3 回调、AA `execute`、flash-loan 回调。
3. **按跨合约调用**：谁调用本合约、本合约调用谁（`msg.sender` 是可信任的 caller 吗？）。
4. **按存储写入**：grep 状态变量被赋值的位置，反向找入口。
5. **按事件**：每个 `emit` 对应一次状态变化，顺藤摸瓜。
6. **按代理**：`fallback` 里的 delegatecall、`upgradeTo`、`setImplementation`、beacon。
7. **按初始化**：`initialize` / `init` / constructor / `__gap`。

## 入口分类（7 元组）

对每个入口填：

```text
Entry Point → Permission → Inputs → State Reads → State Writes → External Calls → Asset Effect
```

| 字段 | 问题 |
|------|------|
| Entry Point | 函数名 + 签名 |
| Permission | 谁能调（见下方权限分类） |
| Inputs | 参数是否攻击者可控、是否校验了 `msg.sender`/`amount`/`deadline`/`recipient` |
| State Reads | 读了哪些状态（余额、价格、share、nonce、timestamp） |
| State Writes | 改了哪些状态 |
| External Calls | 调用外部合约的时机与返回值处理 |
| Asset Effect | 谁变富、谁变穷、mint/burn 了什么 |

## 权限分类

- **Public / Permissionless**：无 modifier 或 modifier 恒真。
- **Role Restricted**：AccessControl `onlyRole`、自定义 `onlyXxx`。
- **Owner / Admin**：`onlyOwner`、`onlyAdmin`。
- **Governance**：提案 → 时间锁 → 执行（注意时间锁参数与提案幂等）。
- **Contract-only**：`require(msg.sender == x)`，x 是合约地址。
- **Callback**：只能被特定协议（token/池子/AA entrypoint）回调。
- **Cross-chain Message**：由 relayer/bridge/oracle 触发。
- **Upgrade / Proxy**：`upgradeTo`、`changeProxyAdmin`、`setImplementation`。
- **Initialization**：`initialize`/`init`（重点：能否被抢跑、能否重放）。

## 优先分析的入口特征

以下特征的入口风险最高，优先深挖：

- 转移资产 / mint / burn。
- 改变 share / debt / collateral。
- 修改价格 / oracle / 费率。
- 修改权限 / admin / implementation。
- 跨链 mint / release / burn。
- 调用不可信外部合约（token、callback、任意 `address` 参数）。
- 读取攻击者可影响的状态（spot price、`balanceOf(this)`、timestamp、`msg.value`）。

## 常见攻击面盲区

- **捐赠面**：`balanceOf(address(this))` 被用作计价分母 → donation 攻击（见 `defi-invariants.md`）。
- **回调面**：外部调用发生在内部 accounting 完成之前 → 跨函数 reentrancy。
- **`msg.value` 面**：循环中 `msg.value` 重复计入、refund 逻辑。
- **delegatecall 面**：`implementation` 可被注入、storage 冲突。
- **价格面**：直接读 spot price、`getReserves`、无 TWAP 的 AMM 价格。
- **签名面**：`ecrecover` 未校验 signer、replay、`deadline` 缺失。
- **初始化面**：proxy 未初始化、initializer 无 `onlyInitializing`、constructor 在 implementation 上执行。

## 输出

把枚举结果沉淀为攻击面清单（`scripts/summarize-surface.py` 的 JSON 可作为骨架，人工补全 permission 与 asset effect 两列），供 Phase 4 的 invariant 推演逐条对照。
