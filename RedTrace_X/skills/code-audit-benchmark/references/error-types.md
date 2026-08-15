# 错误类型定义

定义 benchmark 分析中错误判断的分类和特征。

---

## 一、错误类型总览

| 错误类型 | 英文标识 | 描述 | 典型特征 |
|----------|----------|------|----------|
| 数据流分析不精确 | dataflow_imprecise | Agent 认为数据流可达，实际有控制流中断 | 忽略拦截型校验 |
| 防护有效性判断不一致 | protection_disagreement | Agent 和人工对防护措施安全性判断不同 | startsWith vs contains |
| 历史经验使用不当 | history_misuse | 过度依赖或忽略历史记录 | 未验证历史适用性 |
| 代码版本不一致 | version_mismatch | 会话代码与扫描时代码版本不同 | sink 点已移除 |

---

## 二、详细定义

### 1. 数据流分析不精确 (dataflow_imprecise)

**定义**: Agent 认为用户输入可以到达 sink 点，但实际上存在控制流中断（拦截型校验），被污染的数据无法实际到达 sink。

**判定特征**:
- Agent 数据流路径包含查询操作（如 `store.get(id)`、`db.query(key)`）
- Agent 未分析查询结果的空值检查
- 查询键格式受控（如 UUID、数字 ID）

**典型案例**:
```
Agent 推理: taskId 直接拼接到文件路径，无有效防护
人工标注: taskStore.get(taskId) 是拦截型校验，只有符合 UUID 格式的 taskId 才能通过
根因: Agent 忽略了 taskStore.get() 的拦截作用
```

**识别关键词**: `store.get`, `cache.get`, `db.query`, `findById`, `getById`, `return false`, `return null`, `throw`, `拦截`, `校验失败`, `if.*null.*return`

---

### 2. 防护有效性判断不一致 (protection_disagreement)

**定义**: Agent 和人工对同一防护措施的安全性判断不同。

**判定特征**:
- Agent 提到防护措施但认为可绕过
- 人工标注认为防护有效
- 常见于白名单匹配方式争议

**典型案例**:
```
Agent 推理: 白名单使用 startsWith 前缀匹配，可被 http://whitelist.com.evil.com 绕过
人工标注: 参数有进行过滤，urlWhiteList.contains（精确匹配）
根因: Agent 误判白名单实现方式
```

**识别关键词**: `startsWith`, `contains`, `equals`, `白名单`, `黑名单`, `filter`, `validate`, `sanitize`, `校验`, `过滤`

---

### 3. 历史经验使用不当 (history_misuse)

**定义**: Agent 过度依赖历史记录，或忽略了历史记录的适用条件。

**判定特征**:
- Agent 查询了历史记录
- 直接引用历史结论作为判定依据
- 未验证当前场景是否匹配

**典型案例**:
```
Agent 推理: 历史记录显示"参数有过滤，isValidTableName"，因此安全
人工标注: isValidTableName 仅在 preview 方法调用，createTable 方法未调用
根因: Agent 过度依赖历史记录，未验证当前路径是否适用
```

**识别关键词**: `历史`, `历史记录`, `备注`, `history`, `经验`, `相似案例`, `之前`, `已处理`

---

### 4. 代码版本不一致 (version_mismatch)

**定义**: Agent 分析的代码版本与 CodeQL 扫描时的代码版本不同，导致 sink 点不存在或逻辑变化。

**判定特征**:
- Agent 分析了某个方法的逻辑
- 人工标注提到"已重构"、"已移除"、"不存在"
- CodeQL 报告的行号与会话中的行号不匹配

**典型案例**:
```
Agent 推理: 用户输入 URL 到 HttpURLConnection.openConnection()
人工标注: sink 点不存在了，代码中变成了 .setImage(ByteString.copyFrom(loadImageBytes(url)))
根因: 代码重构，sink 点已移除
```

**识别关键词**: `不存在`, `已移除`, `已重构`, `代码变更`, `版本不同`, `sink.*不存在`, `已删除`, `removed`

---

## 三、错误类型判定流程

```
1. 提取 Agent 推理过程（llm_reasoning）
   ├─ 数据流路径
   ├─ 控制流分析
   └─ 防护评估

2. 提取人工标注关键点（comment 字段）
   ├─ Ground truth 结论
   └─ 备注中的防护描述

3. 对比差异
   ├─ 数据流分析差异 → dataflow_imprecise
   ├─ 防护有效性差异 → protection_disagreement
   ├─ 历史记录使用差异 → history_misuse
   └─ 代码版本差异 → version_mismatch

4. 映射 Skill 流程缺陷
   └─ 定位到具体步骤
```

---

## 四、根因映射表

| 错误类型 | 典型根因 | Skill 流程缺陷 |
|----------|----------|----------------|
| dataflow_imprecise | 忽略拦截型校验 | Step 6.2 未明确如何判断拦截型校验 |
| protection_disagreement | 对防护实现方式理解不同 | Step 6.4 缺少防护完整性验证 |
| history_misuse | 未验证历史记录适用性 | Step 5 历史经验使用规范不清晰 |
| version_mismatch | 会话代码与扫描版本不同 | Step 4 未验证代码版本一致性 |
