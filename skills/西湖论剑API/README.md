# 西湖论剑API Skill

用于让 Agent 在**西湖论剑平台上解答 CTF 题目**。

该 Skill 封装西湖论剑平台 Agent API，负责：

- 获取竞赛规则与公告；
- 获取 CTF 题目列表和题目详情；
- 获取题目附件、靶机 IP/端口、账号和代理映射；
- 按需启动题目环境并轮询到可用；
- 将平台信息交给 Agent 开展实际 CTF 解题；
- 提交 flag 并校验是否正确；
- 查询得分/排名；
- 按需回收题目环境。

## 安装

将整个 `西湖论剑API` 目录复制到支持 `SKILL.md` 的 Agent skills 目录。

## 最小配置

```bash
export AI_AGENT_HOST='https://example.com'
export AI_AGENT_ACCESS_KEY='ak_xxx'
python3 scripts/slab_agent_api.py match-info
```

## 目录

- `SKILL.md`：西湖论剑 CTF 解题工作流与 Agent 决策规则。
- `scripts/slab_agent_api.py`：零第三方依赖的平台 API CLI。
- `references/api_doc.md`：原始 API 接入文档。
