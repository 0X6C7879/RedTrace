# 删除模式

## 使用场景

清理错误记录、重复记录、批量删除。

**触发场景**：
- 清理错误的 API 记录
- 删除重复的 API 记录
- 批量删除某个目录
- 清理测试/工具类 API

---

## 禁止操作

- 禁止不带 `--dry-run` 或 `--confirm` 参数执行删除
- 禁止删除未备份的重要数据
- 禁止批量删除前不预览

---

## Step 1: 预览删除

**触发条件**：需要删除 API 记录

**必做动作**：
1. 构建删除条件（**--git 必填**，限制删除范围）
2. 执行 `--dry-run` 预览
   ```bash
   python3 $REDTRACE_SKILLS_DIR/route-skills/upstream/skills/code-audit/scripts/api_inventory_cli.py delete \
     --git <git-url> \
     --file-pattern "%/reg/%" \
     --dry-run
   ```

**结束门槛**：
- 预览结果符合预期 → 进入 Step 2
- 预览结果不符 → 调整条件重新预览

---

## Step 2: 确认删除

**触发条件**：预览结果确认无误

**必做动作**：
1. 执行 `--confirm` 删除
   ```bash
   python3 $REDTRACE_SKILLS_DIR/route-skills/upstream/skills/code-audit/scripts/api_inventory_cli.py delete \
     --git <git-url> \
     --file-pattern "%/reg/%" \
     --confirm
   ```
2. 观察删除结果

**结束门槛**：
- 删除成功 → 输出汇总
- 删除失败 → 检查条件参数

---

## 常用删除模式

| 场景 | 命令 |
|------|------|
| 删除某 git 所有 API | `--git <url> --confirm` |
| 删除某目录所有 API | `--git <url> --file-pattern "%/routes/%"` |
| 删除测试文件 API | `--git <url> --file-pattern "%/__tests__/%"` |
| 删除工具类 API | `--git <url> --file-pattern "%/utils/%"` |
| 删除特定文件 API | `--git <url> --file "apps/src/api/import.ts"` |
| 删除特定 HTTP 方法 | `--git <url> --method GET --confirm` |
| 删除特定 API 方法 | `--git <url> --api-method getUserInfo --confirm` |
| 按 ID 删除 | `--git <url> --ids 1,2,3 --confirm` |
| 预览 ID 删除 | `--git <url> --ids 1,2,3 --dry-run` |

---

## 参数说明

| 参数 | 说明 | 示例 |
|------|------|------|
| `--git` | Git 地址（**必填**，限制删除范围） | `--git "github.com/user/repo"` |
| `--file` | 精确匹配文件路径 | `--file "src/api/user.ts"` |
| `--file-pattern` | 文件路径模糊匹配 | `--file-pattern "%/reg/%"` |
| `--method` | HTTP 方法 | `--method GET` |
| `--api-method` | API 方法名 | `--api-method getUserInfo` |
| `--ids` | 按 ID 删除，逗号分隔（**必须同时指定 --git**） | `--git <url> --ids 1,2,3` |
| `--dry-run` | 预览不删除 | `--dry-run` |
| `--confirm` | 确认删除（必需） | `--confirm` |

---

## 安全说明

1. **--git 必填**：限制删除范围，防止跨仓库误删
2. **必须使用 `--confirm` 或 `--dry-run`**：不带这两个参数会报错，防止误删
3. **ID 删除需校验归属**：使用 --ids 时会校验 ID 是否属于指定 git，不属于则拒绝删除
4. **推荐流程**：先执行 `--dry-run` 预览，确认无误后执行 `--confirm`
5. **删除不可恢复**：删除前请确认数据可重新发现
