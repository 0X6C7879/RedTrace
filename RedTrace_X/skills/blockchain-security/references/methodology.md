# Blockchain Security — 方法论

这是 blockchain-security Skill 的完整工作流定义。SKILL.md 只保留摘要，本文件是执行细节。所有公开方法论（Trail of Bits / QuillShield / shuvonsec / Yaklang）已融合成这一条工作流，不在其他 reference 中重复定义完整流程。

## 总体原则

1. **先建模，后扫描**：静态分析工具用于扩大覆盖和找候选点，其输出不是 Finding。
2. **资产流优先**：一切漏洞最终表现为"攻击者资产凭空增加 / 协议或用户资产损失 / 权限被非法改变 / 关键 invariant 被破坏"。
3. **多步骤攻击链**：最有价值的是跨函数、跨合约、跨交易序列的业务逻辑漏洞，而非单函数里的显式 bug。
4. **证据驱动**：Finding 必须 Reachable + Attacker Controlled + Impact Demonstrated。

## Phase 1 — Stack Detection

用 `scripts/detect-stack.py` 自动识别，再人工确认。识别项：

- **Chain / VM**：EVM、Solana、Sui/Aptos Move、Starknet(Cairo)、TON、CosmWasm、Substrate。
- **Language**：Solidity、Vyper、Rust、Move、Cairo、FunC/Tact。
- **Build system**：Foundry / Hardhat / Truffle / Brownie / Ape、Anchor、Scarb、Cargo、Move.toml。
- **Source / Bytecode 可用性**：有源码还是只有 bytecode（bytecode 走反编译 + 存储/调用分析）。
- **RPC / fork 环境**：是否有本地节点、mainnet fork 能力、archive node。
- **Proxy / Upgradeability**：transparent / UUPS / beacon、initializer 是否可重放。

## Phase 2 — 三个基础模型

### A. Asset Model

回答：钱在哪里，怎么进出。

- 列出协议持有的所有资产（token、native、LP、staked derivatives、NFT）。
- 每个资产的进入路径（deposit/mint/swap/bridge）与离开路径（withdraw/burn/redeem/claim）。
- 资产如何跨合约流动：外部调用、`transferFrom`、原生 `call{value}`、cross-contract message。
- 哪些状态决定"用户余额"与"协议资产"：`mapping(address=>uint) balances`、`totalSupply`、`totalAssets`、`shares`、`collateral`、`debt`。
- 特别关注**派生资产**（shares、receipt token、LP token、wrapped token）：它们的计价与兑换关系是否被外部因素（捐赠、harvest、oracle）破坏。

### B. Permission Model

回答：谁能改关键状态。

- 权限主体：Owner、Admin、Role（AccessControl）、Multisig、Governance、Proxy Admin、keeper/operator。
- permissionless 路径：任何 EOA/合约可调用的路径。
- 依赖 external signer / message / oracle 的路径：签名验证是否严格、message 是否可伪造/重放、oracle 是否可操纵。
- 初始化路径：`initialize`/`init` 是否可被非授权方抢占（initializer replay / front-run）。

### C. State Model

画出关键状态的依赖链。示例（lending）：

```text
deposit → shares/collateral → borrow → debt → oracle(price) → healthFactor → liquidation → withdraw
```

示例（vault/ERC4626）：

```text
deposit → shares = assets * totalSupply / totalAssets → yield(harvest) → totalAssets ↑ → withdraw → assets = shares * totalAssets / totalSupply
```

对每条状态链，追问：哪个环节可以被外部输入（价格、回调、捐赠、时序）打断，造成上下游状态不一致。

## Phase 3 — Entry Point Analysis

吸收 Trail of Bits entry-point-analyzer：枚举所有 state-changing 入口并分类。

分类维度：

| 分类 | 说明 |
|------|------|
| Public / Permissionless | 任何人可调 |
| Role Restricted | AccessControl / modifier 限权 |
| Owner / Admin | onlyOwner 等 |
| Governance | 提案 + 时间锁 + 执行 |
| Contract-only | 只能被指定合约调用 |
| Callback | receive/fallback/onERC1155Received/uniswapV3Callback 等 |
| Cross-chain Message | 桥消息、relayer、预言机消息 |
| Upgrade / Proxy | upgradeTo、changeAdmin、setImplementation |
| Initialization | initialize/init/constructor |

每个入口记录 7 元组：

```text
Entry Point → Permission → Inputs → State Reads → State Writes → External Calls → Asset Effect
```

**优先分析**会做以下事情的入口：转移资产、mint/burn、改 share/debt/collateral、改价格、改权限、改 implementation、跨链 mint/release、调用不可信外部合约。

工具：`scripts/summarize-surface.py` 生成骨架，再人工核对。

## Phase 4 — Invariant Discovery（核心）

主动提出"协议必须永远满足的条件"，然后找破坏它的交易序列。详见 `defi-invariants.md`。

通用 invariant 清单：

- Asset conservation：总资产守恒，mint 必须有对应 deposit/message，burn 必须有对应 withdraw/release。
- Share/Asset accounting consistency：`totalAssets == Σ user redeemable`。
- Debt consistency：债务不能在没有偿还/清算时消失。
- Collateralization：`collateral * price >= debt * liqThreshold` 恒成立。
- Authorization：非授权方不能改权限、不能改 implementation、不能偷取他人资产。
- Supply：`totalSupply` 与底层资产一一对应，无凭空增发。
- Price/Oracle assumptions：短期价格异常不能产生无限借贷/套利能力。
- Upgrade：升级前后 storage layout 兼容，initializer 不重放。
- Cross-chain message uniqueness：一条消息只 mint/release 一次，来源可信。
- Replay resistance：签名/消息不可跨链或跨交易重放。

推演格式：

```text
Transaction A → State X → Transaction B → State Y → Invariant Broken
```

## Phase 5 — Vulnerability Analysis

使用 `vulnerability-taxonomy.md` 的唯一分类，不在这里重复。

## Phase 6 — Exploit Validation

使用 `exploit-validation.md`。核心：`Reachable + Attacker Controlled + Impact Demonstrated`；EVM 优先 Foundry/Anvil/fork；无法复现标 `unverified hypothesis`。

## 各链执行

EVM 主线最完整；其他链先读通用工作流 + 对应链 reference（`solana.md` / `move.md` / `cairo.md` / `ton-cosmos-substrate.md`），只叠加差异项。
