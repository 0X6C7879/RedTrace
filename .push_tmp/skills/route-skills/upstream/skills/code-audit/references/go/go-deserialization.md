# 反序列化

## 0. 黄金法则

> **漏洞存在性判断 优先于 防护有效性判断**
>
> 反序列化到具体类型 + 无反射操作 = 无反序列化漏洞（这是漏洞本质判断，不是防护有效判断）
>
> 满足此条件时：立即终止分析，无需检查任何防护措施。

**强制执行顺序**：
1. **首先**：找到 sink 点反序列化代码（如 `json.Unmarshal()`）
2. **然后**：分析目标类型（具体类型 vs interface{}）
3. **仅当** 反序列化到 interface{} 且有反射操作时，才继续检查防护措施
4. **禁止**：一上来就检查"有没有类型校验"

**Go 安全特性**：Go 的 JSON/GOB/XML 反序列化不会自动执行代码，风险远低于 Java/Python。主要风险来自 `interface{}` + 反射/动态调用。

---

## 1. 结论判断标准

| 结论 | 定义 | 判定条件 |
|------|------|----------|
| **漏洞** | 反序列化到 interface{} 且有反射/动态调用，数据来自用户输入 | 1. 反序列化到 interface{} 且类型未校验; 2. 数据来自用户输入; 3. 存在反射/动态调用; 4. HTTP 入口可达 |
| **风险-A** | interface{} 反序列化但无 HTTP 入口可达 | 1. interface{} 反序列化; 2. 数据流不可追踪到外部入口; 3. 非测试/非配置代码 |
| **风险-B** | 有 HTTP 入口可达，但防护不充分 | 1. 存在 interface{} 反序列化; 2. HTTP 入口可达; 3. 有部分类型校验但不足 |
| **安全** | 无危险写法，或有充分的有效防护 | 1. 反序列化到具体类型; 2. 类型断言安全; 3. 数据来自可信源; 4. 非线上环境 |

---

## 2. 漏洞风险的研判思路

### 2.1 反序列化 API 与类型检查（第一优先级）

| API | 危险等级 | 说明 |
|-----|----------|------|
| `json.Unmarshal(data, &struct)` | 低 | 具体类型 → 安全 |
| `gob.NewDecoder().Decode(&struct)` | 低 | 具体类型 → 安全 |
| `xml.Unmarshal(data, &struct)` | 低 | 具体类型 → 安全 |
| `json.Unmarshal(data, &interface{})` | 中 | 取决于后续处理 |
| `yaml.Unmarshal(data, &interface{})`（yaml.v2） | 中 | 默认不安全，需 SafeLoader |
| `msgpack.Unmarshal(data, &interface{})` | 中 | 取决于后续处理 |

### 2.2 研判流程

```
Step 1: 环境检查
  ├─ 非线上环境？ → 安全
  └─ 线上环境/无判断 → 继续

Step 2: 目标类型检查
  ├─ 具体类型（struct）？ → 安全
  ├─ interface{} 但有完整类型 switch？ → 安全
  └─ interface{} 无类型校验 → 继续

Step 3: 数据来源检查
  ├─ 固定配置文件/数据库（内部写入）？ → 安全
  └─ 用户输入/来源不明 → 继续

Step 4: 后续处理检查
  ├─ 仅读取基础类型？ → 安全
  ├─ 反射操作/动态调用？ → 漏洞
  └─ 无危险操作 → 继续

Step 5: HTTP 入口可达性分析
  ├─ 无 HTTP 入口？ → 风险-A
  └─ 有 HTTP 入口 → 漏洞/风险-B
```

### 2.3 降级条件表

| 条件 | 原结论 | 降级后 |
|------|--------|--------|
| 具体类型反序列化 | 漏洞 | 安全 |
| 有效类型断言/switch | 漏洞 | 安全 |
| 可信数据源 | 漏洞 | 安全 |
| 无 HTTP 入口 | 漏洞 | 风险-A |
| 无危险后续操作 | 漏洞 | 风险-B |

### 2.4 总结判定表

| 检查项 | 结论 |
|--------|------|
| 反序列化到具体 struct | 安全 |
| interface{} + 完整类型 switch | 安全 |
| 数据来自配置文件/数据库（内部写入） | 安全 |
| interface{} + 反射操作 + 用户输入 + HTTP 入口 | 漏洞 |
| interface{} + 部分类型校验 | 风险-B |
| 无 HTTP 入口 | 风险-A |

---

## 3. 常见漏洞/风险场景

### 场景1：interface{} + 反射操作

```go
var data interface{}
json.NewDecoder(r.Body).Decode(&data)
m := data.(map[string]interface{})
action := m["action"].(string)
executeAction(action)  // 漏洞
```

### 场景2：YAML 反序列化（未使用 SafeLoader）

```go
var config interface{}
yaml.Unmarshal(userYaml, &config)  // 漏洞：yaml.v2 默认支持任意类型
```

### 场景3：动态方法调用

```go
var data map[string]interface{}
json.NewDecoder(r.Body).Decode(&data)
reflect.ValueOf(obj).MethodByName(data["method"].(string)).Call(nil)  // 漏洞
```

### 场景4：风险-B（部分类型校验）

```go
var data interface{}
json.NewDecoder(r.Body).Decode(&data)
if m, ok := data.(map[string]interface{}); ok {
    processMap(m)  // 风险-B：只检查了外层类型
}
```

---

## 4. 常见防御模式

```go
// 具体类型反序列化
var user User
json.NewDecoder(r.Body).Decode(&user)  // 安全

// interface{} + 完整类型 switch
switch v := data.(type) {
case string: processString(v)
case int:    processInt(v)
default:     return errors.New("unsupported type")
}  // 安全

// YAML 具体类型反序列化
var config Config
yaml.Unmarshal(data, &config)  // 安全：具体类型

// 可信数据源
db.QueryRow("SELECT data FROM cache WHERE id = ?", id).Scan(&data)  // 安全
```

---

## 5. 检索技巧

### 关键 Sink 点

| API | 危险级别 |
|-----|----------|
| `json.Unmarshal()` / `json.NewDecoder().Decode()` | 低（取决于类型） |
| `gob.Decode()` | 低（取决于类型） |
| `xml.Unmarshal()` | 低（取决于类型） |
| `yaml.Unmarshal()`（yaml.v2） | 中（需 SafeLoader） |
| `msgpack.Unmarshal()` | 低（取决于类型） |
| `proto.Unmarshal()` | 低（类型固定） |

### 检测命令

```bash
# 检测反序列化
grep -rn "json.Unmarshal\|gob.Decode\|xml.Unmarshal\|yaml.Unmarshal" --include="*.go"

# 检测 interface{}
grep -rn "interface{}\|map\[string\]interface{}" --include="*.go"

# 检测反射调用
grep -rn "reflect\..*MethodByName\|reflect.*Call" --include="*.go"
```

---

## 6. 常见误判场景

### 陷阱1：JSON 反序列化误判

**错误**: 看到 `json.Unmarshal` 就认为漏洞
**正确**: Go 的 JSON 反序列化相对安全，需检查后续类型使用

### 陷阱2：interface{} 误判

**错误**: 看到 `interface{}` 就认为漏洞
**正确**: 需检查后续类型处理逻辑，完整 switch → 安全

### 陷阱3：gob 误判

**错误**: 认为 gob 编码安全
**正确**: gob 可编码 interface{}，需检查类型使用

### 陷阱4：忽略数据来源

**错误**: 看到反序列化就判定漏洞
**正确**: 数据来自固定配置 → 安全

---

## 7. 特殊风险

### interface{} + 反射利用链

Go 反序列化本身不执行代码，但 `interface{}` + `reflect` 可构造利用链：

```go
var data interface{}
json.NewDecoder(r.Body).Decode(&data)
// 攻击者控制 data 中的类型名字段 → 反射调用危险方法
reflect.ValueOf(svc).MethodByName(data["method"].(string)).Call(nil)
```

### yaml.v2 任意类型实例化

yaml.v2（非 v3）默认允许反序列化任意类型，可被利用构造非预期对象。

---

## 8. 变更影响分析

| 变更类型 | 变更内容 | 风险 |
|----------|----------|------|
| 新增 | 新增 json.Unmarshal 到 interface{} | 检查后续类型处理 |
| 新增 | 新增反射操作 | 代码执行风险 |
| 新增 | 新增 YAML 处理 | 确认 SafeLoader |
| 修改 | 从具体类型改为 interface{} | 类型安全风险 |
| 修改 | 移除类型校验 | 引入风险 |
| 删除 | 删除类型校验 | 引入风险 |
| 删除 | 删除环境判断 | 可能在线上执行 |

---

## 9. 质量门禁（强制执行）

在输出审计结论前，按顺序验证：

- [ ] 黄金法则强制执行顺序已遵守（先检查目标类型）
- [ ] 研判流程按顺序执行，无跳过
- [ ] 具体类型直接终止（漏洞本质判断先于防护判断）
- [ ] HTTP 入口可达性已确认，非假设
- [ ] 结论与证据一致，代码行号可追溯
- [ ] 已应用误报排除规则

**上一项未通过，禁止进入下一项。最终检查未通过，禁止宣布审计完成。**
