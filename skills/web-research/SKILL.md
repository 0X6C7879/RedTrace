---
name: web-research
description: Web research strategy — provider priority, URL retention, and when to re-research based on new evidence.
---

# Web Research Strategy

Web 调研策略。仅在需要互联网调研时加载。

**加载后首先执行：** `redtrace-skill recall web-research`

## 优先级

1. Claude/Codex: 原生 Web search/fetch 优先
2. 共享 `brave-search` Skill 作为 fallback
3. Pi: 直接使用 `brave-search`

## 规则

- 保留 URL，成功的 query 不得换 provider 重复执行
- 出现新 fingerprint、版本、报错或知识缺口时重新调研
