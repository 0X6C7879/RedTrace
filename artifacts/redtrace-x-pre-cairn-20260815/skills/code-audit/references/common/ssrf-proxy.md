# SSRF 隔离代理

**SSRF 隔离代理是公司统一的外网访问代理，自动拦截内网访问，防止 SSRF 漏洞。**

## 核心原则

1. **内网隔离**：代理服务器禁止访问内网地址（127.0.0.1、10.x.x.x、192.168.x.x 等）
2. **外网访问**：仅允许访问外网地址
3. **DNS Rebinding 防护**：自动处理 DNS 重绑定攻击
4. **30X 跳转支持**：支持自动跟随重定向并校验目标地址

## 网络可达性优先原则

> **在判断「有没有 SSRF 防护」之前，必须先判断「是否存在 SSRF 漏洞」。**
>
> **关键认知**：
> - **网络不可达 = 事实防护**：无 HTTP 入口本身就是一种防护，应判定为 risk-a 而非 vulnerability
> - **代码有风险 ≠ 实际可利用**：静态分析报告代码风险，不报告运行时可利用性
> - **漏洞存在性判断 > 防护有效性判断**：如果漏洞不存在（如无 HTTP 入口），防护缺失就不再是问题
>
> **判定流程**：
> ```
> 1. 首先检查：网络可达性（是否有 HTTP 入口）
>    └─ 不可达 → risk-a（终止，无需检查防护）
> 2. 然后检查：URL 结构（Host 是否可控）
>    └─ 仅 path/query 可控 → safe（终止）
> 3. 最后检查：防护措施（隔离代理/白名单等）
> ```

## 识别规则（关键）

| 代理名称特征 | 是否为隔离代理 | 判定依据 |
|------------|------------|---------|
| 名称含 `anti` | 是 | 变量名匹配 |
| 名称含 `ssrf` | 是 | 变量名匹配 |
| **配置来源为 `antiSsrfProxiesList`** | **是（例外规则）** | **配置溯源优先** |
| 其他代理名称 | 需执行历史记录核查后判定 | 见下方冲突处理规则 |

**示例**：
- 是：`httpAntiSsrfClient`、`antiSsrfProxy`、`SSRFProxy`
- 是（例外）：`SquidProxyUtils.getProxy("china")` → 配置来源为 `antiSsrfProxiesList`
- 需核查：`ad.takumi.proxy_ip`、`ksHttpProxy`、`httpProxy`、`proxyClient`

### 历史记录与规则冲突处理

当代理变量名不含 `anti`/`ssrf`，且配置溯源结果无法确认为 `antiSsrfProxiesList` 时，若历史记录中该文件/项目**精确标注"已接入ssrf隔离代理"**，则：

1. **必须**以历史记录作为判定依据，判定该代理具备隔离能力，结论为 safe；**禁止**以"历史记录可能误判"为由推翻此结论
2. **例外**（主要适用于 mr-review 模式）：当本次审计的代码变更涉及新增网络请求或替换代理配置时，历史标注不适用，必须按标准流程重新判定；sast-audit 模式下此例外通常不触发
3. 在结论的 `remarks` 字段中记录：代理 Kconf key 不符合标准识别规则，依据历史记录判定为隔离代理，建议人工确认代理实际隔离能力
4. 若历史记录无此标注，则维持"不是隔离代理"判定

### 例外规则：配置溯源优先

**原则**：当变量名不含 `anti`/`ssrf`，但配置来源可追溯到 `antiSsrfProxiesList` 时，仍判定为隔离代理。

**溯源方法**：

```java
// 场景：变量名不含 anti/ssrf
ProxySelector proxy = SquidProxyUtils.getProxy("china");

// 溯源步骤
// 1. 使用 Grep 搜索 SquidProxyUtils 实现
// 2. 找到 getProxy 方法实现
// 3. 确认是否从 Kconf 获取 antiSsrfProxiesList 配置
```

**判定规则**：

| 溯源结果 | 判定 | 说明 |
|---------|------|------|
| 配置直接来自 `antiSsrfProxiesList` | 是隔离代理 | 配置溯源成功 |
| 配置间接引用 `antiSsrfProxiesList` | 是隔离代理 | 追踪到最终来源 |
| 配置来自其他 Kconf key / 来源不明确 | 进入历史记录核查 | 见"历史记录与规则冲突处理" |

## Kconf 配置

**唯一隔离代理配置**：`public.httpProxy.antiSsrfProxiesList`

- 这是公司唯一具有 SSRF 防护能力的代理配置
- 其他 Kconf 代理 key 不具备内网隔离功能
- 提供 `china`、`china-edge`、`foreign` 三组代理服务器

## Java 接入模式

| 模式 | 说明 |
|------|------|
| `KconfGroupedProxySelector.of(..., "antiSsrfProxiesList")` | 从隔离代理配置获取 |
| `httpAntiSsrfClient` | 变量名含 anti |
| `antiSsrfProxy` | 变量名含 ssrf |

## 禁止的误判

**错误判定**：
> 使用代理 `ksHttpProxy`，有 SSRF 防护 → 安全

**正确判定**：
> 代理名称 `ksHttpProxy` 不含 `anti`/`ssrf`，不是隔离代理 → 不能作为防护证据

## 代码模式示例

```java
// 安全：使用隔离代理
ProxySelectorEx proxy = KconfGroupedProxySelector.of(bizName, null, "antiSsrfProxiesList");
HttpClient client = new OkHttpClient.Builder()
    .proxy(proxy)
    .build();

// 安全：变量名含 anti
@Autowired
private RestTemplate httpAntiSsrfClient;

// 安全：变量名含 ssrf
private HttpClient antiSsrfProxy;
```

## 注意事项

1. **内网访问例外**：如有内网访问需求，不能接入此代理，需使用白名单校验
2. **异常处理**：被拦截时返回 403，需正确处理异常
3. **协议使用**：设置代理时使用 `http://`，不要用 `https://`

---

## 快速检查清单

### 常见代理工具类及溯源方法

| 工具类/方法 | 溯源步骤 | 典型配置来源 |
|------------|---------|-------------|
| `SquidProxyUtils.getProxy(name)` | 搜索 `SquidProxyUtils` 实现 → 查看 `getProxy` 方法 → 确认是否读取 `antiSsrfProxiesList` | `antiSsrfProxiesList` 或其他 Kconf key |
| `KconfGroupedProxySelector.of(...)` | 查看第三个参数 → 若为 `antiSsrfProxiesList` 则是隔离代理 | 第三个参数字符串 |
| `httpAntiSsrfClient` | 变量名含 `anti`/`ssrf` → 直接判定为隔离代理 | - |
| `RestTemplate` Bean | 搜索 Bean 定义 → 检查是否设置 proxy → 追踪 proxy 来源 | 配置类 |
| `OkHttpClient.Builder().proxy()` | 检查 proxy 参数来源 → 追踪变量赋值 | 变量定义处 |

### 检查流程（强制顺序）

```
发现代理使用
    │
    ├─ Step 1: 变量名检查
    │   ├─ 含 anti/ssrf → 是隔离代理，判定 safe
    │   └─ 不含 → 继续
    │
    ├─ Step 2: 配置溯源
    │   ├─ 搜索工具类实现（如 SquidProxyUtils）
    │   ├─ 追踪到最终配置来源
    │   └─ 确认是否为 antiSsrfProxiesList
    │
    └─ Step 3: 判定
        ├─ 配置来源为 antiSsrfProxiesList → 是隔离代理，判定 safe
        └─ 其他配置来源 / 来源不明 → Step 4: 历史记录核查
            ├─ 该文件/项目历史记录精确标注"已接入ssrf隔离代理" → 是隔离代理，判定 safe
            │   （在 remarks 中注明：代理 Kconf key 不符合标准识别规则，依据历史记录判定，建议人工确认）
            └─ 历史记录无此标注 → 不是隔离代理，继续研判
```

### 典型判定案例

| 场景 | 代码片段 | 判定 | 依据 |
|------|----------|------|------|
| 变量名含 anti | `@Autowired RestTemplate httpAntiSsrfClient;` | 是隔离代理 | 变量名匹配 |
| 变量名含 ssrf | `HttpClient ssrfProxyClient;` | 是隔离代理 | 变量名匹配 |
| 配置来源明确 | `KconfGroupedProxySelector.of(biz, null, "antiSsrfProxiesList")` | 是隔离代理 | 配置溯源成功 |
| 配置非 antiSsrfProxiesList，历史有标注 | `ad.takumi.proxy_ip` → 溯源非 antiSsrfProxiesList，历史精确标注"已接入ssrf隔离代理" | 是隔离代理 | 历史记录核查通过 |
| 配置非 antiSsrfProxiesList，历史无标注 | `SquidProxyUtils.getProxy("china")` → 溯源来自其他 Kconf，历史无标注 | 不是隔离代理 | 配置溯源与历史记录均不支持 |
| 来源不明，历史无标注 | `OkHttpClient.Builder().proxy(proxy).build()` → 溯源后来源不明，历史无标注 | 不是隔离代理 | 无法确认防护 |

