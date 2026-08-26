# 复盘：PHP 合同审批系统 download.php 路径遍历读 flag

## 目标类型
Web CTF（PHP + Apache），登录后业务系统。

## 关键经验（已验证、可复用）
1. 前端/页面源码里的 `console.log('管理员审批接口临时开放 / TODO 上线前加回权限验证')`
   是典型干扰项（red herring）：源码审计后确认并不存在独立的 approve 端点，
   不要把时间耗在 ffuf 爆破 /api/、approve.php、audit.php 等路径上。
2. 真正的洞在 `download.php` 的 `id` 参数：`$file_path = CONTRACTS_DIR . $file_id`
   未做 `../` 清洗（CWE-22 路径遍历），且 `require_login()` 只校验「已登录」
   不校验角色，低权限账号即可任意文件读取。
3. 利用顺序：
   - `login.php` 用任意测试账号（页面明文提示的 employee/employee123）登录拿 PHPSESSID；
   - `download.php?id=../includes/auth.php`、`id=../includes/config.php` 读 PHP 源码，
     可拿到 $USERS 明文凭据、隐藏 sensitive 合同条目、文件目录常量；
   - `download.php?id=../../../../flag.txt` 直接读根目录 /flag.txt（flag 一般在容器根目录）。
4. 判别「子目录访问被拒」时要用真实源码复验：先前结论误判为「仅允许当前目录 PDF/.htaccess」，
   实测 `../includes/auth.php` 可完整读出源码——务必以源码审计为准，不要停留在黑盒推测。

## 复现要点（脱敏）
- 登录：POST /login.php (username/password)
- 读源码：GET /download.php?id=../includes/config.php
- 读 flag：GET /download.php?id=../../../../flag.txt

## 关键词
php, cwe-22, path-traversal, download.php, lfi, red-herring, ct f-web
