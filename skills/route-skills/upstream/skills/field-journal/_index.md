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
- [2026-08-13_redtrace-inetutils-telnetd-user-env-login-f-bypass](./2026-08-13_redtrace-inetutils-telnetd-user-env-login-f-bypass.md) — GNU inetutils telnetd免认证登录:经NEW-ENV/OLD-ENV提交USER=-f root被拼入login -f root。关键:getterminaltype的ttloop对NEW_ENVIRON与OLD_ENVIRON两个时钟各等一次,必须同时回两组IS否则永久挂起;再完成telnetd_run协商(SGA/ECHO/LINEMODE/NAWS/STATUS/LFLOW/TM)即得root shell；关键词: telnetd, inetutils, USER, environment, login, -f, autologin, NEW-ENV, OLD-ENV, ttloop, getterminaltype
- [2026-08-13_redtrace-php-download-id-path-traversal-read-flag](./2026-08-13_redtrace-php-download-id-path-traversal-read-flag.md) — PHP 合同审批系统 download.php 的 id 参数存在 CWE-22 路径遍历（CONTRACTS_DIR 拼接未清洗 ../，且 require_login 只校验登录不校验角色），低权限账号登录后 id=../../../../flag.txt 读根目录 flag；页面 console.log 提示的临时开放审批 API 是干扰项，无独立 approve 端点，不要浪费在 ffuf 爆破上；关键词: php, cwe-22, path-traversal, lfi, download.php, red-herring, ctf-web, 任意文件读取
- [2026-08-13_redtrace-flask-coupon-claim-race-condition-tocou](./2026-08-13_redtrace-flask-coupon-claim-race-condition-tocou.md) — Flask 电商优惠券领取接口 check-then-act 竞态(TOCTOU)绕过每人限领一张限制：同一 session 并发 POST claim 接口可领取多张优惠券，多张叠加抵扣凑够高价商品金额后 0 元购买 flag 商品。修复：对 user_id 加唯一约束或事务锁/原子 upsert。；关键词: race condition, TOCTOU, Flask, coupon, concurrency, web, ctf
- [2026-08-13_redtrace-web-diagnostic-panel-hardcoded-creds-db-download](./2026-08-13_redtrace-web-diagnostic-panel-hardcoded-creds-db-download.md) — 诊断面板/管理后台类 Web 题：前端 JS atob(base64) 硬编码超管密码；/db/<appname>.db 可绕过目录 403 直接下载 SQLite，flag 明文存 config 表 system_flag，无需登录绕过或 SQLi。；关键词: hardcoded credential, base64, sqlite download, config table, diagnostic panel, web
- [2026-08-13_redtrace-ssrf-field-blind-cmd-injection](./2026-08-13_redtrace-ssrf-field-blind-cmd-injection.md) — SSRF 盲打后端 JSON 字段名（复合词字典，前端字段可能是误导）命中 target_endpoint；内网归档工具 tar 命令拼接 filename 可注入 ;cmd;# 读 flag；关键词: SSRF, 字段名盲打, target_endpoint, 命令注入, 归档工具, filename注入
- [2026-08-13_redtrace-python-eval-template-ssti-subclasses-rce](./2026-08-13_redtrace-python-eval-template-ssti-subclasses-rce.md) — 自定义 Python 求值模板引擎 SSTI 逃逸：半吊子沙箱只封 __import__/globals/dir 裸名、未封 dunder 内省，经 object.__subclasses__ 定位 os._wrap_close 用 popen 达 RCE；关键词: SSTI, 模板注入, Python沙箱逃逸, __subclasses__, os._wrap_close, 模板渲染内核, RCE
- [2026-08-13_redtrace-ssh-weak-password-password-variant-missing-from-wordlists](./2026-08-13_redtrace-ssh-weak-password-password-variant-missing-from-wordlists.md) — SSH/面板弱口令爆破时，P@ss 家族字典常收录 P@ssw0rd/Passw0rd 却遗漏 P@ssword（字母o）；应系统枚举大小写/@-a/o-0/s-$ 替换组合，内网跳板机 admin 优先试 P@ss 家族+公司名拼音变体；关键词: ssh, brute-force, weak-password, wordlist, password, 跳板机, 弱口令, 爆破
- [2026-08-13_redtrace-azure-sas-portal-account-sas-list-blobs-query-injection](./2026-08-13_redtrace-azure-sas-portal-account-sas-list-blobs-query-injection.md) — Azure Blob Storage SAS 门户：账户级 SAS(srt=sco)过度授权 + 代理端点 f-string 拼接 URL 未过滤，通过 blob='?restype=container&comp=list&junk' + sas='&<token>' 注入，用无害空参数 junk? 吸收拼接产生的 ?、前置 & 保持 se/sp/sv/ss/srt/sig 原样，触发 List Blobs 枚举容器内 blob 名后读取 flag。；关键词: Azure Blob Storage, Azurite, 账户级SAS, srt=sco, list blobs, 查询注入, restype, comp=list, 代理URL拼接, 过度授权
- [2026-08-13_redtrace-jdwp-rce-output-readback](./2026-08-13_redtrace-jdwp-rce-output-readback.md) — JDWP调试端口RCE输出回读：Runtime.exec->getInputStream->readAllBytes->ArrayReference.GetValues取byte[]原文，避免Scanner NewInstance空回包；Jetty NIO断点须用ServerSocketChannelImpl.accept；关键词: jdwp, rce, output-readback, readAllBytes, jetty-nio, java-debug


## 使用说明

1. 新任务开始前，先按场景分类查找是否有相似记录。
2. 命中真实项目时，优先复用已验证的流程和踩坑记录。
3. 命中种子案例时，只作为方法参考，不视为真实成功记录。
4. 新增经验后，请按 PR 流程更新本索引，避免直接改动共享主线。
