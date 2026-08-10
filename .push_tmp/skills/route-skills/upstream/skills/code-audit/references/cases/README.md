# 漏洞案例库

> 整合内部真实漏洞与业界经典案例，提供实战指导

## 案例来源

| 来源 | 说明 |
|------|------|
| 内部漏洞库 | 公司内部真实漏洞案例，经脱敏处理 |
| 乌云知识库 | WooYun 平台历史案例（2010-2016），公开数据 |

## 案例列表

| 案例文档 | 漏洞类型 | 内部案例 | 乌云案例 |
|---------|---------|---------|---------|
| [idor-cases.md](idor-cases.md) | IDOR越权访问 | ✓ | ✓ |
| [sqli-cases.md](sqli-cases.md) | SQL注入 | ✓ | ✓ |
| [xss-cases.md](xss-cases.md) | XSS跨站脚本 | ✓ | ✓ |
| [rce-cases.md](rce-cases.md) | 远程命令执行 | ✓ | ✓ |
| [ssrf-cases.md](ssrf-cases.md) | SSRF服务端请求伪造 | ✓ | ✓ |
| [file-upload-cases.md](file-upload-cases.md) | 文件上传 | ✓ | ✓ |
| [unauthorized-cases.md](unauthorized-cases.md) | 未授权访问 | ✓ | ✓ |
| [info-disclosure-cases.md](info-disclosure-cases.md) | 信息泄露 | ✓ | ✓ |
| [logic-flaws-cases.md](logic-flaws-cases.md) | 逻辑漏洞 | ✓ | ✓ |
| [weak-password-cases.md](weak-password-cases.md) | 弱口令 | ✓ | ✓ |
| [csrf-cases.md](csrf-cases.md) | CSRF跨站请求伪造 | ✓ | ✓ |
| [open-redirect-cases.md](open-redirect-cases.md) | 开放重定向 | ✓ | - |
| [file-traversal-cases.md](file-traversal-cases.md) | 路径遍历 | - | ✓ |
| [xxe-cases.md](xxe-cases.md) | XXE外部实体注入 | - | ✓ |
| [misconfig-cases.md](misconfig-cases.md) | 配置错误 | ✓ | ✓ |

## 使用方式

1. 按漏洞类型查找对应案例文档
2. 参考「内部真实案例」了解企业常见漏洞模式
3. 参考「业界经典案例」学习攻击手法和绕过技巧
4. 参考「方法论总结」掌握高频参数和检测信号

## 格式说明

每个案例包含：
- **漏洞描述**：问题说明
- **技术细节**：入口参数、攻击向量
- **修复方案**：具体修复建议
- **经验总结**：关键洞察

---

*内部案例已脱敏处理，移除敏感信息，仅保留技术价值*
