# 模型主动检索离线漏洞库

## 边界

漏洞情报查询只访问本地文件；模型端点可以联网。这不是 harness 被动关联，也不订阅 Fact/HTTP/Nmap 事件，不扫描目标，不运行模板或 PoC。保持原 FGS、Reason、Explore、DSH 和插件开关。

在插件管理页保持 `redtrace-knowledge` 启用。工具 `knowledge_search` 的描述会动态显示数据目录和 SQLite 的绝对路径；无库时显示缺失并返回本地诊断，无在线回退。默认目录是项目根目录下 `.redtrace/data/knowledge`，可通过 `common_env.REDTRACE_DATA_DIR` 覆盖。工具按当前任务配置解析路径，不向模型暴露其他环境变量或密钥。

## 工具调用

```json
{"query":"CVE-2021-41773"}
{"query":"Apache"}
{"component":"Apache","version":"2.4.49"}
{"query":"Apache Tomcat 9.0.90"}
{"component":"OpenSSL","version":"1.0.1f"}
{"component":"widget","vendor":"acme","version":"1.5.0","version_scheme":"semver"}
{"cpe":"cpe:2.3:a:apache:http_server:2.4.49:*:*:*:*:*:*:*"}
{"component":"Apache","offset":5,"limit":5}
```

以上是 `knowledge_search` 的独立调用参数。编号精确查询不会 OR 到其他编号；多词自由文本使用 FTS5 的 AND。组件先查 CPE 产品索引；Apache/httpd、Apache Tomcat、OpenSSL、IIS 等明确别名携带厂商消歧，泛化产品名不擅自猜厂商。返回的 input 显示解析后的名称、版本和厂商。

`versionMatch` 为 `affected/not_affected/unknown`，表示已知版本范围关系，不表示目标漏洞已成立。未知版本仍返回组件相关 CVE；默认组件查询排除确定不受影响的版本，`include_excluded:true` 可查看排除项，明确 CVE 查询仍保留条目和匹配状态。返回 NVD 的上下界及包含/排除语义、更新时间、来源路径、代际、总数和下一页偏移；未知环境条件仍保持 `status:unknown`；含否定条件的平铺版本摘要保留 unknown，需读原始配置。

`knowledge_read({"id":"CVE-2021-41773"})` 返回完整 NVD 描述、配置条件和出处；也可传来源 SHA256 id 读取本地模板或 PoC。单片最多 8192 字节，用 offset/length 继续。不同生态的版本规则用成熟库，不把所有版本强行当 SemVer；不认识的格式保持 unknown。数字点分版本使用 packaging，OpenSSL、PyPI、Maven、Debian、RPM 使用 univers，严格 SemVer 使用 semantic_version。

## 数据维护与离线安装

- 维护机显式执行 `./install-knowledge.sh --online`，获取 NVD 2.0 年度 JSON feed（META SHA256 校验）、Nuclei Templates、ExploitDB。查询进程没有这条下载分支。
- `node scripts/knowledge.mjs status` 查看本地状态。
- `node scripts/knowledge.mjs export --output /absolute/path/knowledge.tar.gz` 导出当前数据代际。
- 新机器需要 Node 24.15+、Python 3.12+、对应平台的 Python wheelhouse；把 wheelhouse 放在 `.redtrace/runtime/knowledge/wheelhouse`，执行 `./install-knowledge.sh --offline --package /absolute/path/knowledge.tar.gz`。安装使用 pip --no-index，不需要 Go、Docker 或常驻检索服务。可用 `REDTRACE_KNOWLEDGE_BOOTSTRAP_PYTHON=/absolute/path/python3.14` 选择与 wheelhouse 对应的解释器（macOS 的 /usr/bin/python3 可能过旧）。Bash 安装脚本面向 macOS/Linux，Windows 使用 WSL 或自行准备 Python 运行时并设置 `REDTRACE_KNOWLEDGE_PYTHON`。
- 缺源/解析错误默认阻止完整代际发布；部分数据需显式 --allow-partial。新索引先在临时代际构建，完整性检查通过后原子切换 current.json，旧代际保留；支持显式 rollback --generation。
- 导入包拒绝路径穿越、符号链接、超限包和不匹配的数据库/来源哈希。SHA256 是完整性校验，不是可信发布者签名；只导入可信维护机的包。
- 数据库按主键、组件索引和 FTS5 搜索，只给当前页加载来源；哈希检查按文件状态缓存，同一查询缓存最多 128 项，代际切换使缓存键改变。没有 embedding、额外模型调用或后台预检索。

## 成熟项目依据

- [go-cve-dictionary](https://github.com/vulsio/go-cve-dictionary)：本地 CVE 数据库与按 CVE/CPE 查询的模式；这里复用已有 SQLite/工具入口，不额外启动服务。
- [NVD 2.0](https://nvd.nist.gov/developers/vulnerabilities)：使用原始 CVE、CPE 配置、版本边界和否定/AND/OR 条件，不从模板名猜版本范围。
- [Grype](https://github.com/anchore/grype)：参考漏洞数据库与扫描生命周期分离的原则；没有把 Grype 扫描器接入 harness。
- [univers / VulnerableCode](https://github.com/aboutcode-org/univers)：按生态比较版本，而不是手写跨生态版本解析器。
- [Nuclei Templates](https://github.com/projectdiscovery/nuclei-templates) 与 [ExploitDB](https://gitlab.com/exploit-database/exploitdb)：保留原始模板/PoC 和哈希，通过 CVE 标识关联，只检索/读取，不自动执行。

NVD 覆盖度和受影响版本数据随公开源变化；离线无命中、数据未分析或 unknown 都不是安全结论。此实现未声称覆盖所有生态的全部漏洞，也未测量真实模型命中率或 token 收益。
