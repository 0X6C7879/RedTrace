# JavaScript 通用检索技巧

## HTTP 入口点识别

### Express 框架

#### 路由识别

| 模式 | 说明 |
|------|------|
| `app.get\|app.post\|app.put\|app.delete` | 应用级路由 |
| `router.get\|router.post\|router.put` | 路由器级路由 |

#### 参数来源

| 属性 | 来源 | 可控性 |
|------|------|--------|
| `req.query` | URL 查询参数 | 可控 |
| `req.params` | URL 路径参数 | 可控 |
| `req.body` | 请求体（需 body-parser） | 可控 |
| `req.headers` | 请求头 | 部分可控 |
| `req.cookies` | Cookie | 部分可控 |

#### 识别命令

```bash
# 查找 Express 路由
grep -rn "app\.get\|app\.post\|router\.get\|router\.post" --include="*.js"

# 查找用户参数
grep -rn "req\.query\|req\.params\|req\.body" --include="*.js"
```

#### 代码示例

```javascript
// GET 请求
app.get('/user/:id', (req, res) => {
    // URL 路径参数，可控
    const userId = req.params.id;

    // 查询参数，可控
    const name = req.query.name;

    res.json({ userId, name });
});

// POST 请求
app.post('/user', (req, res) => {
    // 请求体，可控
    const { username, email } = req.body;

    res.json({ username, email });
});
```

---

### NestJS 框架

#### 路由识别

| 装饰器 | 说明 |
|--------|------|
| `@Controller()` | 控制器声明 |
| `@Get()\|@Post()\|@Put()\|@Delete()` | 路由方法 |

#### 参数来源

| 装饰器 | 来源 | 可控性 |
|--------|------|--------|
| `@Param()` | URL 路径参数 | 可控 |
| `@Query()` | URL 查询参数 | 可控 |
| `@Body()` | 请求体 | 可控 |
| `@Headers()` | 请求头 | 部分可控 |

#### 识别命令

```bash
# 查找 NestJS 控制器
grep -rn "@Get\|@Post\|@Controller" --include="*.ts"

# 查找参数装饰器
grep -rn "@Param\|@Query\|@Body" --include="*.ts"
```

#### 代码示例

```typescript
@Controller('users')
export class UsersController {
    @Get(':id')
    findOne(@Param('id') id: string, @Query('name') name: string) {
        // URL 路径参数和查询参数，可控
        return { id, name };
    }

    @Post()
    create(@Body() createUserDto: CreateUserDto) {
        // 请求体，可控
        return createUserDto;
    }
}
```

---

### Koa 框架

#### 路由识别

| 模式 | 说明 |
|------|------|
| `router.get\|router.post` | 路由注册 |
| `async (ctx) =>` | 中间件/处理函数 |

#### 参数来源

| 属性 | 来源 | 可控性 |
|------|------|--------|
| `ctx.query` | URL 查询参数 | 可控 |
| `ctx.params` | URL 路径参数 | 可控 |
| `ctx.request.body` | 请求体（需 body-parser） | 可控 |
| `ctx.headers` | 请求头 | 部分可控 |

#### 识别命令

```bash
# 查找 Koa 路由
grep -rn "router\.get\|router\.post" --include="*.js"

# 查找上下文参数
grep -rn "ctx\.query\|ctx\.params\|ctx\.request\.body" --include="*.js"
```

#### 代码示例

```javascript
router.get('/user/:id', async (ctx) => {
    // URL 路径参数，可控
    const userId = ctx.params.id;

    // 查询参数，可控
    const name = ctx.query.name;

    ctx.body = { userId, name };
});
```

---

## 执行环境识别

### 前端 vs 后端识别信号

| 信号 | 前端 | 后端 |
|------|------|------|
| 导入模块 | `import React` / `import axios` | `require('sequelize')` / `require('child_process')` |
| 数据访问 | `axios.get('/api/users')` | `User.findAll()` / `db.query()` |
| 框架特征 | `React.useState` / `Vue.component` | `app.get` / `@Controller` |
| 文件位置 | `src/components/` / `client/` | `server/` / `models/` / `routes/` |

### 环境检测命令

```bash
# 前端检测
grep -rn "import React\|from 'react'\|from 'vue'" --include="*.js" --include="*.jsx"

# 后端数据库检测
grep -rn "require('sequelize')\|require('mongoose')\|require('mysql')" --include="*.js"
```

---

## 数据流追踪方法

### 从 sink 点向上追溯

```javascript
// Step 1: 识别 sink 点
db.query(`SELECT * FROM users WHERE name = '${name}'`);  // sink

// Step 2: 追踪参数来源
// name 从哪里来？

// Step 3: 继续向上追溯
// 使用 Grep 搜索调用者

// Step 4: 找到入口点
// 确认路由处理函数
```

### 识别命令

```bash
# 追踪数据流 - 使用 Grep 搜索调用关系

# 追踪变量赋值
grep -rn "const.*=.*req\.query" --include="*.js"

# 追踪函数调用
grep -rn "functionName(" --include="*.js"

# 追踪对象解构
grep -rn "{.*}.*=.*req\.body" --include="*.js"
```

---

## 环境判断检测

```bash
# 检测环境判断
grep -rn "isProd\|isTest\|isDev\|isLocal\|process\.env\.NODE_ENV" --include="*.js"

# 检测环境变量
grep -rn "process\.env\." --include="*.js"
```

---

## 防护措施检查方法

| 检查项 | 检索方法 |
|--------|----------|
| 参数化查询 | Grep: `prepare\|execute(\$1\|?` |
| 类型转换 | Grep: `Number(\|parseInt(\|String(` |
| 白名单定义 | Grep: `ALLOWED_\|WHITELIST\|includes(\|has(` |
| 校验函数实现 | Grep: 搜索函数定义 |

**详细防护规则**：
- 净化措施判定：`references/common/sanitization.md`
- 可信数据源判定：`references/common/trusted-sources.md`
- SSRF 隔离代理：`references/common/ssrf-proxy.md`

---

## 可达性判定总结

| 条件 | 可达性 | 结论 |
|------|--------|------|
| 有 Express/NestJS/Koa 路由，参数来自用户输入 | 可达 | 漏洞/风险/安全取决于防护 |
| 无入口点，仅内部函数 | 不可达 | 风险 |
| 参数来自常量/配置 | 不可达 | 风险 |
| 前端代码（React/Vue） | 无 HTTP 入口 | 不适用 |
