# 项目经验索引

> 本文件用于在新任务开始前快速检索历史经验。
> 带 `[种子]` 标记的条目是预置参考案例，不计入真实完成项目。
> 真实项目使用日期文件名（例如 `2026-05-16_*`），种子案例使用 `seed-*`。

## 统计

- 真实项目数：20
- 种子参考数：17
- 总条目数：37

## 按场景分类

### APK / Android 逆向

- [2026-05-15-cellular-pro-mumu-ksad-fragment-fix](./2026-05-15-cellular-pro-mumu-ksad-fragment-fix.md)
- [[种子] seed-008_apk-okhttp-ssl-pin-bypass](./seed-008_apk-okhttp-ssl-pin-bypass.md)

### 二进制 / 固件 / CTF

- [2026-07-14_android-arm64-self-extract-source-recovery](./2026-07-14_android-arm64-self-extract-source-recovery.md)
- [2026-05-15_lumine-go-reverse](./2026-05-15_lumine-go-reverse.md)
- [[种子] seed-001_elf-packed-loader](./seed-001_elf-packed-loader.md)
- [[种子] seed-002_go-malware-stripped](./seed-002_go-malware-stripped.md)
- [[种子] seed-010_ctf-pwn-rop-x64](./seed-010_ctf-pwn-rop-x64.md)
- [[种子] seed-011_pcap-protocol-reverse](./seed-011_pcap-protocol-reverse.md)
- [[种子] seed-014_unity-il2cpp-reverse](./seed-014_unity-il2cpp-reverse.md)
- [[种子] seed-015_iot-firmware-uart](./seed-015_iot-firmware-uart.md)

### Web / API / 渗透测试

- [2026-07-18_gin-juice-client-friction](./2026-07-18_gin-juice-client-friction.md)
- [2026-07-05_dsl-vm-captcha-reverse](./2026-07-05_dsl-vm-captcha-reverse.md)
- [2026-06-29_burp-mcp-full-test-and-fix](./2026-06-29_burp-mcp-full-test-and-fix.md)
- [2026-05-26_pentest-newapi-rate-limit-bypass](./2026-05-26_pentest-newapi-rate-limit-bypass.md)
- [2026-05-25_pentest-cf-access-sibling-subdomain-cookie-poisoning](./2026-05-25_pentest-cf-access-sibling-subdomain-cookie-poisoning.md)
- [2026-05-17_pentest-vue-spa-actuator-leak](./2026-05-17_pentest-vue-spa-actuator-leak.md)
- [2026-05-16_pentest-personalblog-fun-mass-assignment](./2026-05-16_pentest-personalblog-fun-mass-assignment.md)
- [[种子] seed-003_web-api-auth-bypass](./seed-003_web-api-auth-bypass.md)
- [[种子] seed-004_js-sign-webpack](./seed-004_js-sign-webpack.md)
- [[种子] seed-006_ssrf-cloud-metadata](./seed-006_ssrf-cloud-metadata.md)
- [[种子] seed-017_xxe-oob-exfil](./seed-017_xxe-oob-exfil.md)

### 企业内网 / 云安全

- [[种子] seed-005_ad-certipy-esc1](./seed-005_ad-certipy-esc1.md)
- [[种子] seed-007_ntlm-relay-coercer](./seed-007_ntlm-relay-coercer.md)
- [[种子] seed-013_kerberoasting-spn](./seed-013_kerberoasting-spn.md)
- [[种子] seed-016_k8s-container-escape](./seed-016_k8s-container-escape.md)

### iOS 逆向

- [[种子] seed-009_ios-jailbreak-detect-bypass](./seed-009_ios-jailbreak-detect-bypass.md)

### 其他

- [[种子] seed-012_log4shell-jndi-rce](./seed-012_log4shell-jndi-rce.md)

### RedTrace 自动回写

- [2026-08-03_redtrace-fact-filesystem-drift-detection](./2026-08-03_redtrace-fact-filesystem-drift-detection.md) — Fact-graph assertions about file existence and code state may diverge from physical filesystem; always verify with direct filesystem inspection before relying on fact-described changes as ground truth.；关键词: fact-filesystem-drift, verification, graph-vs-reality, payload-audit, offline-exploit
- [2026-08-06_redtrace-web-cmdi-newline-bypass-sqli-case-filter](./2026-08-06_redtrace-web-cmdi-newline-bypass-sqli-case-filter.md) — Newline (%0a) command injection bypass in filtered network diagnostic tools; case-variation SQL keyword filter bypass (sElEcT/uNiOn) for SQLite/MySQL；关键词: command-injection, newline-bypass, ping, sqli, case-bypass, filter-bypass, waf-bypass
- [2026-08-09_redtrace-tcp-protocol-build-dump-heap-leak](./2026-08-09_redtrace-tcp-protocol-build-dump-heap-leak.md) — TCP行协议服务的BUILD/DUMP/EXPORT命令在输出内部数据结构时可能泄露未初始化相邻堆内存中的敏感数据（flag/key/pointer），应先检查此类输出区域；关键词: tcp, heap-leak, uninitialized-memory, build-dump, information-disclosure, pwn, protocol-service
- [2026-08-09_redtrace-tcp-protocol-build-dump-heap-leak-2](./2026-08-09_redtrace-tcp-protocol-build-dump-heap-leak-2.md) — TCP行协议服务的BUILD/DUMP/EXPORT命令在输出内部数据结构时可能泄露未初始化相邻堆内存中的敏感数据，应先检查此类输出区域；关键词: tcp, heap-leak, uninitialized-memory, build-dump, information-disclosure, pwn, protocol-service
- [2026-08-09_redtrace-cve-2026-24061-inetutils-telnetd-auth-bypass](./2026-08-09_redtrace-cve-2026-24061-inetutils-telnetd-auth-bypass.md) — CVE-2026-24061：GNU inetutils-telnetd 1.9.3–2.7 认证绕过。通过 telnet NEW-ENVIRON 选项发送 USER=-f root 环境变量，注入 -f root 命令行参数绕过认证直接获取 root shell（CVSS 9.8）。；关键词: CVE-2026-24061, inetutils, telnetd, auth-bypass, NEW-ENVIRON, USER-injection, root-shell, CVSS-9.8, telnet-protocol
- [2026-08-09_redtrace-business-logic-price-validation-bypass](./2026-08-09_redtrace-business-logic-price-validation-bypass.md) — 电商应用购买接口未校验优惠券总额是否覆盖商品价格，导致可低价/免费购买高价值商品；关键词: business-logic, price-validation, coupon, purchase-bypass, flask, e-commerce
- [2026-08-09_redtrace-business-logic-price-validation-bypass-2](./2026-08-09_redtrace-business-logic-price-validation-bypass-2.md) — 电商应用购买接口未校验优惠券总额是否覆盖商品价格，导致可低价/免费购买高价值商品；关键词: business-logic, price-validation, coupon, purchase-bypass, flask, e-commerce
- [2026-08-09_redtrace-old-oa-sqli-to-ssti-rce-chain](./2026-08-09_redtrace-old-oa-sqli-to-ssti-rce-chain.md) — 老旧OA系统渗透链：搜索框SQL注入提取管理员凭据 → 管理后台Jinja2 SSTI → RCE。SQLite UNION注入枚举sqlite_master获取表结构，Flask应用使用lipsum.__globals__绕过常见SSTI沙箱限制。；关键词: SQL注入, SQLite, UNION注入, SSTI, Jinja2, Flask, lipsum.__globals__, OA系统, 权限提升, RCE
- [2026-08-09_redtrace-1panel-auth-bypass-entrance-captcha](./2026-08-09_redtrace-1panel-auth-bypass-entrance-captcha.md) — 1Panel v1.x 认证绕过链：安全入口代码可通过 /auth/issafety 枚举，配合 CVE-2025-66507（ignoreCaptcha 客户端可控）和 base64 编码的 EntranceCode header 实现无验证码登录。v1.10.10-lts 仍有此漏洞。；关键词: 1Panel, CVE-2025-66507, captcha-bypass, EntranceCode, authentication-bypass, ignoreCaptcha, security-entrance
- [2026-08-09_redtrace-api-receipt-path-manipulation-arbitrary-file-read](./2026-08-09_redtrace-api-receipt-path-manipulation-arbitrary-file-read.md) — 当 API 响应暴露服务端文件路径字段（如 receipt_path），且更新接口未校验该字段权限时，可通过追加该参数覆盖路径，结合下载接口实现任意文件读取；关键词: receipt_path, arbitrary file read, path manipulation, IDOR, FormData injection, update API


## 使用说明

1. 新任务开始前，先按场景分类查找是否有相似记录。
2. 命中真实项目时，优先复用已验证的流程和踩坑记录。
3. 命中种子案例时，只作为方法参考，不视为真实成功记录。
4. 新增经验后，请按 PR 流程更新本索引，避免直接改动共享主线。
