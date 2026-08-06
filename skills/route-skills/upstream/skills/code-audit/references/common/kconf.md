# Kconf 配置系统

**Kconf 是公司云配置系统，配置内容存放在云端，默认安全且用户不可控。**

## 背景

Kconf 基于 KESS 下发通道，实现了配置中心化管理。配置 key 格式为 `业务部门.系统.子系统.配置名`，支持 Java、Go、Python、Node.js 等多语言 SDK。

## 核心原则

1. **研发自配置**：Kconf 配置由研发人员在云端配置平台维护
2. **用户无法篡改**：普通用户无法修改 Kconf 配置值
3. **默认安全可信**：Kconf 获取的数据为可信数据源
4. **无需验证具体值**：不需要读取云端配置的实际值进行验证
5. **Java 字段默认值 ≠ 运行时值**：当字段由 Kconf/配置系统注入时，Java 代码中的默认值（如 `private String key = ""`）仅为编译时占位符，运行时实际值由 Kconf 配置决定。分析时不能将默认值等同于运行时值。

## 配置类型

| 类型 | 说明 | 常见用途 |
|------|------|----------|
| bool, int32, int64, double, string | 基本类型 | 开关、阈值、URL |
| list_xxx, set_xxx | 列表/集合 | 白名单、黑名单 |
| map_string_xxx | Map 类型 | 键值对配置 |
| json | JSON 对象 | 复杂结构配置 |
| tail_number | 尾号类型 | 灰度放量 |

## 代码模式识别

### Java 模式

| 模式 | 说明 |
|------|------|
| `kconf.getString("key")` | 获取云端配置值，可信数据源 |
| `KconfConstant.ALLOWED_XXX` | 白名单常量来自云端配置 |
| `KconfUtils.getBoolean("key")` | 布尔配置值，可信 |
| `@Kconfig("foo.bar.baz")` | Spring 依赖注入方式 |

### Go 模式

| 模式 | 说明 |
|------|------|
| `kconf.GetInt32Config(key)` | 一次性获取配置值 |
| `kconf.AddWatcherOption(key)` | 注册监听器 |
| `kconf.GetStringConfig(key)` | 获取字符串配置 |

### Python 模式

| 模式 | 说明 |
|------|------|
| `get_string_config(key)` | 获取字符串配置 |
| `get_int32_config(key)` | 获取整数配置 |
| `get_list_string_config(key)` | 获取列表配置 |
| `get_json_config(key)` | 获取 JSON 配置 |

### Node.js 模式

| 模式 | 说明 |
|------|------|
| `kconf.getStringValue(key)` | 获取字符串配置 |
| `kconf.getIntValue(key)` | 获取整数配置 |
| `kconf.getJSONValue(key)` | 获取 JSON 配置 |

## 环境说明

| 环境 | 说明 | 安全性 |
|------|------|--------|
| staging/candidate | 测试环境 | 加密使用公共密钥，不存储真正保密内容 |
| PAZ/AZ/Region | 生产环境 | 等价于访问生产数据库的环境 |
| 自定义环境 | 灰度/特定机器 | 优先级最高 |

## 危险模式：配置获取失败导致校验跳过

> **⚠️ 高危场景**：代码从 Kconf 获取白名单/校验配置，但**未处理获取失败的场景**，导致校验被跳过。
>
> Kconf 配置本身是可信的，但**获取失败时的降级逻辑**可能绕过校验。这不是 Kconf 不可信，而是代码的防御逻辑不完整。

### 危险代码模式

```java
// 危险：getSet() 返回 null/empty 时，contains() 始终返回 false → 跳过校验
Set<String> allowedExts = kconf.getSet("file.upload.allowed.extensions");
if (allowedExts != null && allowedExts.contains(ext)) {
    // 校验通过
}
// 危险：若 allowedExts 为 null，整个 if 块跳过 → 等同于无校验！
saveFile(file, ext);
```

```java
// 更危险：逻辑反转 - 获取失败则直接跳过校验
List<String> whitelist = kconf.getList("upload.whitelist");
if (whitelist == null || whitelist.isEmpty()) {
    // "降级"逻辑：直接通过，不校验
    return true;
}
return whitelist.contains(ext);
```

### 安全代码模式

```java
// 安全：获取失败时拒绝（fail-closed）
Set<String> allowedExts = kconf.getSet("file.upload.allowed.extensions");
if (allowedExts == null || allowedExts.isEmpty()) {
    throw new SecurityException("校验配置不可用，拒绝上传");
}
if (!allowedExts.contains(ext)) {
    throw new IllegalArgumentException("不允许的文件类型");
}
```

### 判定规则

| 场景 | 判定 |
|------|------|
| Kconf 获取成功 + 白名单包含安全后缀 | 安全 |
| Kconf 获取失败 + 代码 fail-closed（抛异常/拒绝） | 安全 |
| Kconf 获取失败 + 代码 fail-open（跳过校验/直接通过） | **漏洞** |
| Kconf 获取失败 + 逻辑分支存在绕过路径 | **漏洞** |

---

## 禁止的误判

**错误判定**：
> 白名单依赖 KconfConstant.ALLOW_DYNAMIC_SPLICE_COLUMNS 配置，配置可能为空 → 缺少信息无法判断

**正确判定**：
> 白名单依赖 Kconf 配置，Kconf 为研发自配置且用户无法篡改的可信数据源 → 安全（参数不可控）

```java
// 安全：Kconf配置（云端可信）
String host = kconf.getString("db.host");  // 可信数据源
String baseUrl = kconf.getString("api.base.url");  // 如 http://internal.com/

// 安全：白名单来自Kconf配置
if (KconfConstant.ALLOW_DYNAMIC_SPLICE_COLUMNS.contains(column)) {
    // Kconf配置为研发自配置且用户无法篡改，默认可信
}
```

**错误判定**：
> securityProxyKey 的 Java 默认值为空字符串 → 运行时代理未配置 → 无防护

**正确判定**：
> securityProxyKey 字段由 Kconf JSON 配置注入（如 HttpClientConfig.securityProxyKey），Java 默认值仅为占位符。
> 根据 Kconf 规则，Kconf 是可信数据源，运行时值由云端配置决定，默认值不作为判断依据。
