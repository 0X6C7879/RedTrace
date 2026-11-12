---
name: recon-crawl
description: Attack-surface crawling with the crawl tool — BFS link/form/hidden-field collection, JS-bundle API route extraction, and auth boundary mapping through the scoped browser. Use this skill when user needs to map a web application's attack surface, enumerate endpoints, discover hidden API routes, or build an endpoint inventory before vulnerability testing.
---

# Attack-Surface Crawling (crawl)

crawl 走真实浏览器访问目标，必须遵守浏览器 scope 与速率约定；页面预算用最小够用的值，不要无差别扫全站。

## RedTrace Workflow

1. 读取当前 Step 的 FGS 契约及引用证据，复用同题已验证身份、Session、地址与已有成果。
2. 用 `http_batch` 保存基线与变体请求；通过返回的 Session Resource 和 Request ID 调用 `http_replay`。请求默认并发；只有测试需要身份或状态隔离时才创建独立 Session。需要前序登录结果的请求，待登录完成后再发。
3. 需要爬取、fuzz 或专用协议时，用 `bash` 运行现有 `curl`、`ffuf`、`sqlmap` 或本 Skill 脚本；真实浏览器交互使用 `playwright-skill` 的脚本和独立 BrowserContext，不假定存在浏览器专用工具。显式向命令传递已验证 Cookie/Authorization，不假定 HTTP Resource 会自动向外部工具导出会话。
4. 同一 Step 内并发测试独立输入；跨 Step 协作由 Reason 调度，不自行调用子 Agent 工具。复用下方 Payload、打法和 references，按实际反馈深入验证。
5. 保存完整请求/响应、对照与实际影响到证据文件。确认关键结论后 `submit_fact({description,evidence:[{description,path}]})`；真实可交付漏洞再 `submit_finding({title,description,factIds})` 引用 Fact。线索不冒充已确认漏洞。
6. 当前 Step 结束前至少提交一条真实证据支持的汇总 Fact；无突破则如实汇总验证范围、失败或阻塞，再 `finish_step({summary})`。普通局部观察先留在证据文件。


---

## Methodology

### 何时用 crawl vs 其他侦察
| 需求 | 工具 |
|------|------|
| 端点/表单/API 路由清单 | `crawl`（本 skill） |
| 隐藏目录/备份文件 | `recon-dir-scan`（词表爆破，互补不替代） |
| 技术栈/版本 | `recon-fingerprint` |
| 子域 | `recon-subdomain` |

标准顺序：`crawl`（拿地图）→ `recon-fingerprint`（定技术栈）→ `recon-dir-scan`（补爆破面）→ exploit skills。

### crawl 结果的局限
- 只跟随同 host 链接；跨 host 记为线索不访问
- JS 路由提取是正则启发式：能拿到大部分字面量端点，拿不到运行时拼接的动态路由——对可疑前端代码配合 `browser evaluate` 手工追
- 登录墙后的页面内容拿不到（只标注 AUTH）；需要认证后的攻击面，先带身份再对关键路径逐个测

---

## Testing Checklist

- [ ] 入口页 crawl（默认参数）拿到基线清单
- [ ] JS routes 逐条分派到 exploit skills
- [ ] Forms 的 hidden 字段单独过一遍（tamper/mass assignment）
- [ ] AUTH 页面带认证身份复测
- [ ] cross-host leads 核对后决定是否扩大 scope
- [ ] 大站按端点组分派 subagent 并行
- [ ] 暴露面验证后 submit_finding

---

### Recording Results

已验证的暴露面先提交 `submit_fact`，再用 `submit_finding` 引用 Fact ID 与证据文件；普通端点清单保存在证据文件，不逐 URL 创建 Finding。

---

## 相关 Skills

`api-testing`（API 面深入）、`exploit-authz`（越权/隐藏域）、`recon-dir-scan`（目录爆破互补）、`recon-fingerprint`（技术栈）、`results-storage`（findings 机制）

## 深度参考

- `references/js-reverse.md`——JS 逆向配合接口挖掘：加密参数还原、隐藏/管理接口提取、硬编码密钥与演示账号发现
