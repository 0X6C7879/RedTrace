# SSH 弱口令爆破：P@ssword 变体常被字典遗漏

## 背景
内网跳板机（堡垒机）SSH 服务开放 password 认证，需爆破 admin 账号弱口令。
前端 HTML 注释泄露线索「admin 账号密码需要定期更换，当前还是弱口令」。

## 关键发现
- 约 170 个常见弱口令字典（含 admin123 / tiandun* / tdsec* / dasheng* / 2024/2025
  组合、P@ssw0rd、Passw0rd、Passw0rd! 等）全部失败。
- 真实口令为 `P@ssword`（大写 P + @ + 字母 o 的 ss + word）。
- 根因：字典收录了 `P@ssw0rd`（数字 0）与 `Passw0rd`，却漏掉了同构的
  `P@ssword`（字母 o）。同类变体在爆破时应系统枚举：大小写、@/a、o/0、s/$ 等
  替换组合，而不是只收录「看起来标准」的那一个。

## 可复用结论
- 爆破 SSH/面板弱口令时，对「P@ss/P@ssw0rd 家族」应生成全组合：
  P@ssword / Passw0rd / P@ssw0rd / Password / P@ssword! / P@ssw0rd! 等。
- 内网跳板机常见默认口令优先尝试：admin 账号 + 上述 P@ss 家族 + 公司名拼音变体。

## 脱敏说明
不含 target、credential 明文、flag 值或 Workspace 绝对路径。
