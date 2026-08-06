# code-audit Learned 经验索引

白盒代码审计的可复用经验索引。详细条目位于 `entries/`，机器可读索引位于 `learned.index`（JSONL）。

写入规则：

- 只能通过 `$REDTRACE_SKILLS_DIR/route-skills/redtrace-tools/code-audit/evolve.py` 事务写入（目录锁 `learned/.lock.d` + 原子替换），并自动追加 `skills/.redtrace/audit.jsonl` 审计记录。
- 只追加，不重写历史条目；条目 ID 形如 `CA-LEARN-xxxx`。
- 必须脱敏：不得包含目标业务名称、内部域名/IP/账号/Token/Cookie、私有仓库地址、不可复用路径、未经验证的猜测。
- 单条经验必须带 trigger、evidence_pattern、reuse_conditions、counterexamples、validation 元数据。
- 满足 reference 直接进化门槛（见 route-skills 融合方案 10.4）时才允许局部更新 `references/`，且更新后必须通过 `validate_bundle.py` 与 `regression.py`。

## 条目列表

（由 evolve.py 自动追加）
