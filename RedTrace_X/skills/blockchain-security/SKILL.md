---
name: blockchain-security
description: Use for authorized blockchain, smart-contract and DeFi security research, including Solidity/EVM, Solana, Move, Cairo, TON, Cosmos and Substrate; protocol logic, asset flow, access control, cross-contract interactions, economic attacks, invariant violations and exploit validation.
---
# 区块链漏洞挖掘

## ACTION REQUIRED（读完后立刻执行）

1. `NOW`: 运行 `redtrace-skill recall blockchain-security`，读取本 Skill 已验证的可复用经验。
2. `NOW`: 确认任务是否命中本 Skill 适用范围（仅限 authorized 的区块链/智能合约/DeFi 安全研究）。
3. `NEXT`: 运行 `python scripts/detect-stack.py <target>` 识别链 / VM / 语言 / 框架 / 协议类型。
4. `NEXT`: 按需读取 `references/` 下对应文件（不要一次全读）。
5. `ACT`: 进入 Phase 1 并执行，不要停留在确认状态。

## 适用范围

- 链 / VM / 语言：Solidity/EVM、Vyper、Solana/Anchor/Pinocchio、Sui Move、Aptos Move、Cairo/Starknet、TON、Cosmos/CosmWasm、Substrate。
- 场景：智能合约审计、DeFi 漏洞挖掘、Bug Bounty、CTF 区块链题目、协议逻辑漏洞、链上资产流安全、代理升级安全、Oracle/Flash Loan/MEV、Bridge/Cross-chain、Signature/Authorization、Exploit/PoC 验证。

## 统一工作流

### Phase 1 — Stack Detection

识别：Chain、VM、Language、Build system、Framework、Protocol type、Source/Bytecode 可用性、RPC/fork 环境、Proxy/Upgradeability。

协议类型至少识别：Token / Vault / Lending / DEX / AMM / Staking / Governance / Bridge / Oracle / NFT / Account Abstraction / Generic Protocol。

工具：`python scripts/detect-stack.py <target>`（输出 JSON）。

### Phase 2 — 建立三个基础模型

- **Asset Model**：钱在哪里；哪些资产进入/离开协议；资产如何跨合约流动；哪些状态决定用户余额或协议资产。
- **Permission Model**：谁能改变关键状态（Owner/Admin/Role/Multisig/Governance/Proxy Admin）；哪些路径 permissionless；哪些依赖 external signer/message/oracle。
- **State Model**：建立关键状态变化关系，例如 `deposit → shares → borrow → oracle → liquidation → withdraw`。

> 不要一开始直接跑 Slither 然后把输出当漏洞。先建模型，再找入口。

### Phase 3 — Entry Point Analysis

枚举所有 state-changing entry points，按权限分类：Public/Permissionless、Role Restricted、Owner/Admin、Governance、Contract-only、Callback、Cross-chain Message、Upgrade/Proxy、Initialization。

每个入口记录：`Entry Point → Permission → Inputs → State Reads → State Writes → External Calls → Asset Effect`。

优先分析会转移资产、mint/burn、改变 share/debt/collateral、修改价格、修改权限、改变 implementation、跨链 mint/release、调用不可信外部合约的入口。

工具：`python scripts/summarize-surface.py <target>`（先得到结构化骨架，再人工/工具补充）。

### Phase 4 — Invariant Discovery（核心）

主动回答："这个协议必须永远满足哪些条件？" 至少检查：asset conservation、share/asset accounting consistency、debt consistency、collateralization、authorization、supply、price/oracle assumptions、upgrade、cross-chain message uniqueness、replay resistance、state transition consistency。

然后推演多步骤攻击链：

```text
Transaction A → State X → Transaction B → State Y → Invariant Broken
```

重点寻找多步骤、跨函数、跨合约的业务逻辑漏洞。细节见 `references/defi-invariants.md` 与 `references/methodology.md`。

### Phase 5 — Vulnerability Analysis

统一 taxonomy 只在 `references/vulnerability-taxonomy.md` 维护一份，共 8 大类：Access & Authorization / State & Accounting / External Interaction / Oracle & Economic / Signature & Authentication / Upgrade & Initialization / Cross-chain & Messaging / Chain-specific Semantics（各链差异见对应 reference）。

### Phase 6 — Exploit Validation

Finding 不允许因为"Slither 报告了"就成立。至少满足：**Reachable + Attacker Controlled + Impact Demonstrated**。EVM 优先 Foundry PoC / Anvil / mainnet fork。无法复现时标记 `unverified hypothesis`，不要写 `confirmed vulnerability`。细节见 `references/exploit-validation.md`。

## 工具发现（不自动安装）

用 `command -v` 检测：`forge cast anvil slither echidna myth solc`。缺失时明确说明能力缺失，继续用现有工具 + 人工方法，**不猜路径、不自动 pip/npm/cargo install**。工具用途见 `references/tool-workflows.md`。

## References（按需读取）

- `references/methodology.md` — 完整工作流与三模型细节
- `references/attack-surface.md` — 攻击面建模与入口分类
- `references/vulnerability-taxonomy.md` — 统一漏洞分类（唯一权威）
- `references/defi-invariants.md` — DeFi 各协议类型 invariant 专项
- `references/exploit-validation.md` — PoC / fork 验证与 before-after 状态
- `references/tool-workflows.md` — 工具用途与命令
- `references/evm-solidity.md` / `solana.md` / `move.md` / `cairo.md` / `ton-cosmos-substrate.md` — 各链差异项
- `references/case-patterns.md` — 可泛化攻击模式（可持续沉淀）

## 任务完成自检（声称完成前 MUST 通过）

- [ ] 是否建好了 Asset / Permission / State 三个模型（而非直接跑扫描器）？
- [ ] 是否枚举了 state-changing entry points 并标注权限与资产效果？
- [ ] 是否明确提出并检验了 invariant（而非只找"Slither 报的"）？
- [ ] 每个 Finding 是否满足 Reachable + Attacker Controlled + Impact Demonstrated？
- [ ] 是否用 `command -v` 检测工具、且没有自动安装任何东西？
- [ ] 高危 Finding 是否给出了可复现 PoC / transaction sequence / before-after 状态？无法复现时是否标记 `unverified hypothesis`？
- [ ] 是否通过 `redtrace-skill learn blockchain-security` 沉淀了可复用、已验证、非项目专属的经验？
