## 概述
本地故意脆弱测试夹具的 debug 参数绕过认证，仅为回归测试，不代表真实目标。

## 影响与危害
Low：仅证明本地夹具的虚拟标记泄露；其他影响未验证。

## 受影响范围
http://127.0.0.1:61419/private，仅本次本地 fixture。

## 复现步骤
### 步骤 1：发送基线请求
操作/输入：curl -sS -i 'http://127.0.0.1:61419/private'。预期/实际：401，需要登录。来源 artifact-8f9407d1bd7b2e9d6f79dfbca291915a0d76d03b2b5d79ac82f3ba1bd6a87434。

### 步骤 2：发送已验证 debug 请求
操作/输入：curl -sS -i 'http://127.0.0.1:61419/private?debug=1'。预期仍需认证；实际 200 并出现虚拟标记。来源 artifact-3e4c8235c6eff19ab03cd257cde498d8fdf3431ca516180f3518ff97d1fc4ee9。

## 证据
原始基线响应：
```http
HTTP/1.1 401 Unauthorized
Date: Fri, 13 Nov 2026 08:12:29 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked

fixture login required
```
原始漏洞证明响应：
```http
HTTP/1.1 200 OK
Date: Fri, 13 Nov 2026 08:12:29 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked

FIXTURE_ONLY_NOT_A_SECRET
```
Producer Run: run-01504894-7af9-45ef-8edf-4c94aa8d6f03；原始 bash 执行记录已读取。

## PoC
复现步骤即为 PoC。
```sh
curl -sS -i 'http://127.0.0.1:61419/private'
curl -sS -i 'http://127.0.0.1:61419/private?debug=1'
```

## 根因分析
已观察到 debug 请求跳过认证；服务端源码未提供给 Reporter，具体实现根因未验证。

## 修复建议
在所有分支执行统一认证检查，删除调试绕过入口；增加基线及 debug 请求的未登录回归测试。