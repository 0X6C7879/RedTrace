# Skill 目录来源与许可证

`skills/` 是 Skill 的 canonical source。运行时首次导入会把它整体复制到 `.redtrace/skills/`（`Capabilities.initialize`，由 `.redtrace/capabilities-imported.json` 哨兵文件守护，已导入的机器不会自动重导；在该机器上新增 Skill 需要手动复制到 `.redtrace/skills/<name>/`）。

每个 Skill 目录必须是 `<name>/SKILL.md`，frontmatter 含 `name`（与目录名一致）与 `description`；`name` 不符或 YAML 非法会让整个 catalog 接口报错。

## 一、本仓库自研 Skill

| Skill | 用途 |
| --- | --- |
| `playwright-skill` | 浏览器自动化、持久会话、页面交互（含 `node_modules`，18 MiB） |
| `tsecbench-api` | TSecBench 平台交互：题目查询、容器管理、Flag 提交 |
| `jev-decision` | Explore 决策辅助：Jev 选择/评估工具的使用约束 |

`typesafe-ai` 由外部引入（来源 `typesafe-ai/skills`，哈希记录在仓库根 `skills-lock.json`），2026-09-29 前已在库。

## 二、外部引入 Skill（2026-10-10 批量拉取，上游 commit 为拉取时 revision）

### ljagiello/ctf-skills @ `c332c7be1b27cb64639a20124ac55ba916adef92`（2026-09-13）· MIT

| Skill | 上游路径 | 文件数 |
| --- | --- | --- |
| `ctf-web` | `ctf-web/` | 24 |
| `ctf-pwn` | `ctf-pwn/` | 24 |
| `ctf-reverse` | `ctf-reverse/` | 20 |
| `ctf-crypto` | `ctf-crypto/` | 20 |
| `ctf-forensics` | `ctf-forensics/` | 15 |

### Ch1nfo/RiftX @ `1e3369f9ae49bde8195ab753fe7dc9b5c37a53e7`（2026-09-21）· MIT

| Skill | 上游路径 | 文件数 |
| --- | --- | --- |
| `recon-crawl` | `recommended-skills/recon-crawl/` | 2 |
| `api-testing` | `recommended-skills/api-testing/` | 3 |
| `exploit-sqli` | `recommended-skills/exploit-sqli/` | 10 |
| `exploit-ssrf` | `recommended-skills/exploit-ssrf/` | 1 |
| `exploit-file-upload` | `recommended-skills/exploit-file-upload/` | 1 |
| `exploit-smuggling` | `recommended-skills/exploit-smuggling/` | 2 |
| `exploit-logic` | `recommended-skills/exploit-logic/` | 2 |
| `exploit-race` | `recommended-skills/exploit-race/` | 2 |
| `exploit-xss` | `recommended-skills/exploit-xss/` | 37 |

注：RiftX 的 `recommended-skills/` 下没有 `recon-js-analysis`，该 Skill 只存在于 CkSKILLS。

### zhaji2333/CkSKILLS @ `482fe78a83ca5b6e1505964bcd433e2bd223c50a`（2026-09-15）· MIT

| Skill | 上游路径 | 文件数 |
| --- | --- | --- |
| `recon-js-analysis` | `.agents/skills/recon-js-analysis/` | 1 |
| `auth-access-control` | `.agents/skills/auth-access-control/` | 1 |

### yaklang/hack-skills @ `6fbf0bc8d5c71830d62543a308d8744606c43d7c`（2026-09-13）· MIT

| Skill | 上游路径 | 文件数 |
| --- | --- | --- |
| `api-authorization-and-bola` | `skills/api-authorization-and-bola/` | 1 |

### trailofbits/skills-curated @ `6d05be4889017b06fb15069f371afd220daffb62`（2026-07-14）· CC-BY-SA-4.0

| Skill | 上游路径 | 文件数 |
| --- | --- | --- |
| `ffuf-web-fuzzing` | `plugins/ffuf-web-fuzzing/skills/ffuf-web-fuzzing/` | 3 |
| `ghidra-headless` | `plugins/ghidra-headless/skills/ghidra-headless/` | 9 |

**注意**：该仓库是 CC-BY-SA-4.0（署名 + 相同方式共享），不是 MIT；二次分发需保留署名并按同许可证共享。

### AIPentest/CyberStrikeAI @ `9e7eb2db5f93319da1de7a62533177a428095e96`（2026-10-10）· Apache-2.0

| Skill | 上游路径 | 文件数 |
| --- | --- | --- |
| `capability-primitive-search` | `skills/capability-primitive-search/` | 1 |

### yhy0/CHYing-agent @ `0d2ee81fa783caf119cde1423e390552e32561c0`（2026-04-25）· MIT

| Skill | 上游路径 | 文件数 |
| --- | --- | --- |
| `stagnation-recovery` | `agent-work/.claude/skills/stagnation-recovery/` | 1 |

### m-sec-org/BreachWeave @ `bc2d9502a2625c5ef354adc30243bd091341cc51`（2026-10-09）· Apache-2.0

| Skill | 上游路径 | 文件数 |
| --- | --- | --- |
| `targeted-pentest` | `packages/core/src/config/skills/builtin/targeted-pentest/` | 16 |

### pale-knight/redteam-skill @ `322d0d9da8c24488b9f43f4c1e9a1ae076f254f9`（2026-08-23）· MIT

| Skill | 上游路径 | 文件数 |
| --- | --- | --- |
| `shell` | `skills/shell/` | 7 |
| `tunnel` | `skills/tunnel/` | 8 |
| `privesc-linux` | `skills/privesc-linux/` | 6 |
| `privesc-win` | `skills/privesc-win/` | 6 |
| `ad-attack` | `skills/ad-attack/` | 10 |
| `service-attack` | `skills/service-attack/` | 14 |

许可证全文见 `THIRD-PARTY-LICENSES/<owner>__<repo>.LICENSE`。

本次共引入 28 个 Skill、247 文件、约 3.9 MiB（`playwright-skill` 的 18 MiB `node_modules` 不计入）。

## 三、更新方法

按仓库 sparse checkout 后覆盖对应目录（`--filter=blob:none` 避免拉全仓）：

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/<owner>/<repo>.git /tmp/<repo>
git -C /tmp/<repo> sparse-checkout set <上游路径...>
rsync -a --delete /tmp/<repo>/<上游路径>/ skills/<name>/
```

覆盖前先更新本文档中记录的 commit 与文件数；本批 Skill 均为上游原样保留（仅 9 个仓库的 LICENSE 单独提取到 `THIRD-PARTY-LICENSES/`），未做内容改写。

## 四、已知集成缺口

- **适配层**：pale-knight 系列（`shell`、`tunnel`、`privesc-linux`、`privesc-win`、`ad-attack`、`service-attack`）保留上游的人工确认流程与项目专属工具约定，尚未替换为 RedTrace 的自动化执行接口，直接使用前需要改写。
- **Python 依赖**：脚本级依赖已核对为 `bs4`、`httpx`、`websockets`、`requests`、`pwn`；前四项中缺少的三项（`beautifulsoup4`、`httpx`、`websockets`）已补进 `deploy.sh` 的 pinned venv 列表（`install_skill_python_dependencies`），`tools/requirements.txt` 原本已声明这三项。
- **外部二进制**：`ffuf-web-fuzzing` 需要 `ffuf`，`ghidra-headless` 需要 Ghidra + Java；`deploy.sh` 已有对应安装路径，本机 `ffuf`/`analyzeHeadless`/`java` 均可用。
- **上游缺陷（未修改，保持原样）**：`exploit-xss/scripts/websocket_xss_tester.py` 第 53 行 `'-alert('XSS')-'` 单引号未转义，Python 3.13/3.14 均报 SyntaxError，该脚本上游即不可运行（已与上游 commit `1e3369f` 逐字节比对确认）。修复方式：把内层单引号改为双引号，如 `"-alert('XSS')-"`。
- **描述文本占用**：32 个 Skill 的 `description` 合计约 11k 字符（约 2.7k tokens），若全量注入 catalog 需评估预算；上游 `SKILL.md` 正文保持原样，未按 RedTrace 精简（先验证再精简）。
- **离线运行**：本次拉取为一次性导入，运行时不触发上游下载。上游 Markdown 里含约 75 处前置依赖安装指引（`pip install`/`brew install`/`go install`/`cargo install`，分布在 34 个 md 文件，如 `ctf-web/SKILL.md`、`ctf-crypto/SKILL.md`），属文档说明、非可执行脚本；`scripts/*.py` 中仅有两处缺依赖时的报错文案（`websockets`、`requests`），不自动安装。离线镜像应靠 `deploy.sh` 预装，勿按这些指引现场联网安装。

## 五、完整性校验

对照上游 revision 校验文件清单（应为 0 missing / 0 extra）：

```bash
gh api repos/<owner>/<repo>/git/trees/<branch>?recursive=1 \
  | jq -r '.tree[] | select(.type=="blob" and (.path|startswith("<上游路径>/"))) | .path | ltrimstr("<上游路径>/")' \
  | sort > /tmp/upstream.txt
(cd skills/<name> && find . -type f | sed 's|^\./||' | sort) > /tmp/local.txt
diff /tmp/upstream.txt /tmp/local.txt
```

2026-10-10 对全部 28 个 Skill 执行该比对：文件清单、文件模式（可执行位）、frontmatter `name` 全部一致。
