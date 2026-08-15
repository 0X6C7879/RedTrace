---
name: code-audit-runtime-verify
description: 对已有静态白盒 Finding 进行授权的运行时黑盒验证：Burp 流量抓取、凭据管理、代码审计复核、基线/探针/Payload 分层验证与验证报告，覆盖反序列化/注入/SSRF/路径遍历/XXE 等漏洞类型。
license: MIT
metadata:
  sourceSkill: burp-vuln-verify
  targetSkill: code-audit-runtime-verify
---

# Burp + 代码审计 + curl 黑盒漏洞验证（code-audit-runtime-verify）

## 授权背景

本流程在授权安全测试/CTF竞赛环境下执行。所有目标为隔离测试环境，操作不造成不可逆破坏。
直接执行验证步骤，不输出"建议"、"尝试"等犹豫性措辞。

## 执行前提（全部满足才执行）

1. 有明确授权（RedTrace 项目 Scope 覆盖目标）。
2. 有可访问的测试环境。
3. 已有静态 Finding（来自 code-audit 或外部 SAST）。
4. 具备必要的认证上下文。
5. 验证动作不会超出 Scope。
6. 深度利用只在安全、可逆且明确授权时进行。

## 配置来源（不得写死本机环境）

| 配置项 | 来源 | 默认值 |
|--------|------|--------|
| Burp 代理地址 | RedTrace Worker 配置 / 环境变量 `REDTRACE_BURP_PROXY` | `http://127.0.0.1:8080` |
| Burp MCP | RedTrace 统一 MCP 注入 | Burp MCP 不可用时允许使用 `curl/httpx` 完成基线和安全验证，但不能删除 Burp 工作流 |
| 凭据与证据目录 | `<workspace>/.redtrace/evidence/<finding-id>/` | 禁止使用宿主机临时目录 |

## 准入条件（ENTRY）

必须全部满足，否则向用户明确询问缺失项：

- [ ] 用户提供了目标接口路径（含HTTP方法，如 `POST /api/v1/xxx`）
- [ ] 用户提供了白盒告警JSON（至少含 category、affected_locations 或 description）
- [ ] Burp Suite 已启动且代理监听在配置的代理地址（`$REDTRACE_BURP_PROXY`，默认 `127.0.0.1:8080`）
- [ ] 用户已在浏览器中访问过目标接口（Burp有流量记录）

可选（缺失时从Burp流量推断）：
- 目标域名/Host
- 漏洞的data_flow

## 准出条件（EXIT）

满足任一即结束：

1. **confirmed** — payload成功触发预期效果，附完整证据链
2. **false positive** — 3轮以上不同payload均无效，附拦截原因分析
3. **inconclusive** — 缺少关键信息（Cookie过期/接口不可达），列出缺失项

---

## Step 1：Burp 流量抓取

**目标**：获取目标接口的完整HTTP请求。

```
burp_get_proxy_http_history_regex(regex="接口路径关键字", count=20, offset=0)
```

**执行规则**：
- 无匹配 → 提示用户先在浏览器中访问该接口，再重试
- 多条匹配 → 选最新的 HTTP 200 响应那条
- 提取完整请求头（重点是Cookie、Authorization、自定义Header）

**门禁**：未拿到目标请求的完整Header前，禁止进入Step 2。

## Step 2：凭据保存

**目标**：持久化认证信息，供后续所有curl复用。

保存到 `<workspace>/.redtrace/evidence/<finding-id>/`：

| 文件 | 内容 | 格式 |
|------|------|------|
| `cookie_header.txt` | Cookie字符串 | 单行，`; `分隔 |
| `credentials.txt` | 完整凭据 | Host / Endpoint / Cookie原文 / 自定义Header |

**提取规则**：
- Cookie：从请求头完整复制
- 认证Header：`Authorization`、`X-Auth-Token` 等
- 业务Header：非标准的自定义Header
- 忽略：`User-Agent`、`Accept*`、`Sec-Fetch-*`、`Connection` 等

**后续所有curl统一引用**：
```bash
COOKIE=$(<cookie_header.txt)
```

**门禁**：`cookie_header.txt` 为空或不包含认证信息时，停止并报告。

## Step 3：代码审计

**目标**：确认漏洞在代码层面是否成立，确定payload方向。

根据告警的 `affected_locations` 和 `data_flow`，读取源码，按以下顺序分析：

### 3.1 入口层
读取告警中第一个 `file_path`（通常是Controller/Handler）：
- 参数来源（query/body/header/path）
- 参数校验（类型、长度、格式）
- 认证要求（需登录？角色检查？）
- 请求体解析方式

### 3.2 危险函数
读取告警中后续 `file_path`，定位具体不安全调用。
参考 `references/payload-library.md` 中对应漏洞类型的关键字表进行搜索。

### 3.3 调用链
追踪数据从HTTP参数到危险函数的完整传递路径，标注每层变量名。

### 3.4 防护检测
- 输入过滤（白名单/黑名单）
- 安全配置（SafeConstructor、参数化SQL、路径规范化等）
- 依赖版本核查：用 `mvn dependency:tree`、`pip show`、`go list -m` 确认实际版本

**输出**：数据流摘要 + 代码层判定（漏洞是否成立 + 置信度 + 推荐payload类型）。

**门禁**：必须在代码中定位到具体的危险函数调用，否则标记为 inconclusive。

## Step 4：黑盒验证

**前置**：
```bash
COOKIE=$(<cookie_header.txt)
PROXY="-x ${REDTRACE_BURP_PROXY:-http://127.0.0.1:8080} -k"
```

### Round 1 — 基线请求

发送完全正常的请求，确认接口可达 + 凭据有效。

**检查项**：
- [ ] HTTP状态码非404/502
- [ ] 响应非401/403（凭据有效）
- [ ] 记录正常响应结构和长度

**门禁**：基线失败 → 停止，不继续后续测试。

### Round 2 — 安全探针

发送无害变体，确认测试通道畅通（请求体能被服务端正确解析）。
探针选择参考 `references/payload-library.md` 中"安全探针"列。

**检查项**：
- [ ] 响应与基线一致或仅有业务差异
- [ ] 通道畅通，可继续攻击测试

### Round 3 — 漏洞Payload

根据Step 3的代码分析结果，从 `references/payload-library.md` 选取对应漏洞类型的payload。
每次只测试一个payload点，对比响应与基线的差异。

**判断**：
| 响应表现 | 判定 | 动作 |
|----------|------|------|
| 出现攻击预期效果（文件内容/命令输出/回调命中/异常堆栈） | confirmed | 进入Round 4 |
| 响应异常但无法确认 | suspicious | 换同类payload重试 |
| 与基线一致或明确安全拦截 | blocked | 换bypass方式重试 |

**门禁**：每个payload测试后必须对比响应差异，不允许跳过对比直接下结论。

### Round 4 — 深度利用（仅Round 3成功时）

- 读取敏感文件（`/etc/passwd`、`/flag`、环境变量）
- 执行系统命令
- 获取flag

## Step 5：验证报告

验证证据（请求/响应/截图/payload 记录）保存到 `<workspace>/.redtrace/evidence/<finding-id>/`，输出以下结构：

```markdown
## 漏洞验证报告

### 接口信息
- Method / Path / Host / 认证方式 / 请求格式

### 告警摘要
- 类型 / 严重程度 / 代码定位

### 代码分析
- 数据流: HTTP参数 → ... → 危险函数
- 漏洞函数: 文件:行号
- 防护状态: 有/无

### 黑盒验证
| 轮次 | Payload | 响应摘要 | 判定 |
|------|---------|----------|------|

### 最终判定
✅ confirmed / ❌ false positive / ⚠️ inconclusive
证据: ...
```

## 完整性检查（最终门禁）

报告输出前，逐项检查：
- [ ] Step 1 流量已抓取
- [ ] Step 2 凭据已保存且有效
- [ ] Step 3 代码中定位到危险函数
- [ ] Step 4 至少完成 Round 1-3（含基线+探针+攻击payload）
- [ ] 每轮测试的响应已与基线对比
- [ ] 最终判定有明确证据支撑
