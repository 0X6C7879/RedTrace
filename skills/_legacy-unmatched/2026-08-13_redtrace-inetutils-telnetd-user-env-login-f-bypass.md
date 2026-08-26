# GNU inetutils telnetd 免认证登录（USER 环境变量注入 login -f）完整利用流程

## 漏洞
GNU inetutils telnetd 的 `login_invocation` 模板为：
`PATH_LOGIN " -p -h %h %?u{-f %u}{%U}"`
未认证（无 AUTHENTICATION）时 `user_name` 为 NULL，`%?u{...}{%U}` 取 `%U` 分支，
即把客户端经 telnet NEW-ENV/OLD-ENV 协商提交的 `USER` 环境变量原样拼入命令，
导致 `USER="-f root"` 时执行 `login -p -h <host> -f root` 免认证登录 root。

## 关键坑（否则服务端永久挂起，不发登录提示）
`getterminaltype()` 依次 `send_do` TTYPE/TSPEED/XDISPLOC/NEW_ENVIRON/OLD_ENVIRON，
客户端对 DO 回复 WILL 后，服务端只对 NEW_ENVIRON 发 SEND（`else if`），
但其后 ttloop 条件对 **BOTH** `environsubopt`(NEW_ENVIRON=0x27) 与
`oenvironsubopt`(OLD_ENVIRON=0x24) 各等待一次 `sequenceIs(...)`。
因此客户端必须同时回复两组 IS：
- NEW_ENVIRON IS: `IAC SB 0x27 IS VAR(0x00) "USER" VALUE(0x01) "-f root" IAC SE`
- OLD_ENVIRON IS: `IAC SB 0x24 IS VAR(0x00) "USER" VALUE(0x01) "-f root" IAC SE`
（OLD_ENVIRON 格式务必是 `VAR 名字 VALUE 值`，不要插多余字节，否则 ENV_HACK
会误判 VAR/VALUE 是否颠倒。）
另需回复 TSPEED IS、XDISPLOC IS、TTYPE IS。

## 第二段协商（telnetd_run）
绕过 getterminaltype 后服务端发 `WILL SGA / DO ECHO / DO LINEMODE / DO NAWS /
WILL STATUS / DO LFLOW`，随后可能 `DO TM`。客户端回复后即打印 Linux motd 并
进入 `root@...:~#` 提示符（无密码）。

## 复现要点
1. 对 DO 全部回 WILL；对 SEND 逐一回 IS（TSPEED/XDISPLOC/NEW_ENVIRON/OLD_ENVIRON/TTYPE）。
2. 第二段：WILL SGA→DO；DO ECHO→WILL；DO NAWS→WILL；DO LINEMODE/LFLOW/TM→WONT；
   WILL STATUS→DO。
3. 无需再发用户名/密码，直接出现 root shell。

## 工具
见 workspace 通用脚本（参数 host port [payload] [cmds...]），无绑定具体目标。
