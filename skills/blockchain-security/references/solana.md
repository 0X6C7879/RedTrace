# Solana 特有语义

只写 Solana / Anchor / Pinocchio 特有差异项，通用分类见 `vulnerability-taxonomy.md`。

## Account ownership

- 每个 account 有 owner program，只有 owner 能修改其 data（跨程序写入受限）。
- 检查：程序是否校验了传入 account 的 owner 是自己，避免写错账户 / 被伪造账户替换。

## Signer checks

- `Signer<...>` / `ctx.accounts.x.is_signer` / `#[account(signer)]`。
- 检查：授权账户是否真的 signer；`mut` 的账户谁负责签名。

## PDA（Program Derived Address）

- 由 program id + seeds + bump 派生，PDA 不是私钥持有者。
- 检查：bump 是否使用 `find_program_address` 的 canonical bump；seeds 是否唯一（避免不同账户碰撞同一 PDA）；PDA 签名 `invoke_signed` 是否正确。

## Seeds

- PDA seeds 决定地址；seeds 必须包含区分因子（用户公钥、类型标识、编号），防止跨账户复用。
- 检查：seeds 是否包含可变、攻击者可控但应唯一的值；是否缺类型前缀导致碰撞。

## CPI（Cross-Program Invocation）

- 调用外部程序：`invoke` / `invoke_signed`。
- 检查：调用的 program id 是否硬编码（不能是攻击者传入）；传给 CPI 的账户是否可信、权限是否最小。

## Account substitution

- 攻击者用同类型但内容不同的账户替换预期账户（例如把用户账户换成金库账户）。
- 检查：是否校验账户地址、owner、类型 discriminator；`remaining_accounts` 是否被混入预期账户。

## remaining_accounts

- 可变长度的附加账户，常被用于可配置 token/池子。
- 检查：数量、顺序、类型是否校验；是否把系统账户当成用户账户处理。

## Anchor constraints

- `#[account(mut, has_one = authority, constraint = ...)]` 是否覆盖所有关键关系。
- 检查：`init` 账户是否由攻击者可预测地址抢占；`close` 是否只允许正确接收者。

## Duplicate mutable accounts

- 同一账户在 instruction 中出现两次（可变），可能绕过校验或双花。
- 检查：是否校验账户互不相同；金额计算是否因重复账户而错乱。

## Instruction sysvar

- `sysvar::instructions` / `clock` / `rent` 等。
- 检查：clock 时间戳被用于结算时是否可操纵（未来区块时间戳）；instruction 内省是否被伪造。

## Program ownership

- 程序升级权限、`upgrade_authority`。
- 检查：是否可被非授权升级；`set_upgrade_authority` 是否遗漏。

## Rent / lamports / close account

- 账户需 rent 豁免；`close` 账户退还 lamports。
- 检查：`close` 的 lamports 接收者是否被校验（不能退给攻击者）；关闭后再初始化（init 竞态）。

## Serialization / discriminator

- Anchor 用 8 字节 discriminator 区分账户类型。
- 检查：自定义序列化是否校验长度/类型；`zero_copy` 账户边界；borsh 反序列化陷阱。

## 其他

- `invoke` 失败传播、`compute budget`（`compute_units`）耗尽 DoS。
- SPL token 的 `transfer_checked`（amount + decimals 双校验）优于 `transfer`。
