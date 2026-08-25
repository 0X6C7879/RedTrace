# 工具工作流

统一管理工具用途。工具用于**扩大覆盖、找候选点、验证假设、自动生成状态探索**；工具输出不是最终 Finding。

## 检测（不自动安装）

```bash
command -v forge cast anvil slither echidna myth solc
```

工具缺失时：明确说明能力缺失，继续用现有工具 + 人工方法，不猜路径，不自动安装（安装由 RedTrace 统一部署逻辑负责）。

## 工具分类

### Static

| 工具 | 用途 |
|------|------|
| Slither | 数据流、权限、reentrancy、`tx.origin`、delegatecall、uninitialized 等候选点；打印 entry point / state 关系 |
| Aderyn | Rust 写的 Solidity 静态扫描，输出按影响分级 |
| Mythril | 符号执行找可到达的状态异常 |

### Dynamic

| 工具 | 用途 |
|------|------|
| Foundry | `forge test` PoC、`forge build` |
| Anvil | 本地链、`--fork-url` 主网 fork |
| cast | `cast call`/`cast send`/`cast storage` 链上状态读写 |

### Fuzz

| 工具 | 用途 |
|------|------|
| Forge fuzz | 参数空间随机探索 |
| Forge invariant | 用 invariant handler 做状态不变量模糊 |
| Echidna | property-based fuzz，写 `crytic_` 属性自动找破坏 |

### Symbolic / Formal

| 工具 | 用途 |
|------|------|
| Halmos | 符号执行（Foundry 集成） |
| Mythril | 符号执行 |
| Certora | 形式化验证（如环境存在） |

### 辅助

| 工具 | 用途 |
|------|------|
| solc / solc-select | 编译、版本切换 |
| web3.py / ethers | 链上交互脚本 |
| crytic-compile | Slither/Echidna 的统一编译前端 |

## 使用原则

- 先 `detect-stack.py` 确定框架，再选工具。
- Slither 用于**生成入口清单和候选点**，配合 `summarize-surface.py` 的人工补全，不直接采信结论。
- Echidna/Forge invariant 用 Phase 4 的 invariant 写 property，自动探索多步骤状态破坏。
- Foundry fork 用于在真实主网状态上验证经济攻击（见 `exploit-validation.md`）。
- 不要在 Skill 内执行 `pip install` / `npm install` / `cargo install` 污染 Worker 环境。
