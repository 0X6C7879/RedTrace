# 工作台项目详情 TodoList UI

## 当前结果

已按用户最终纠正，将 TodoList 放到 **工作台 → 具体项目 / Graph 详情**，不是军团控制台。图谱左上角“阶段计划”按钮和右侧“计划”标签均可打开同一只读面板。

预览：[隔离测试项目详情](http://127.0.0.1:57621/#/projects/proj_001/graphs/main-proj_001)。预览数据为确定性的本地夹具，autoStart=false，未启动真实任务或访问靶场，也未修改或重启 8000 主服务。

## 本轮变更

- 显示完整阶段内容、已完成数量和原生 progress；状态有文字“等待前置条件 / 推进中 / 已完成”，不依赖颜色区分。
- 当前阶段以既有青色强调，其余沿用现有 RedTrace 深色 token、圆角和系统字体。没有装饰性动画或新依赖；保留原有低动态效果设置。
- 清单跟随当前选中 Graph；复用 loadProject 的现有快照请求和五秒刷新，没有增加请求、定时器或另存前端 Todo 状态。
- 通过现有 GET /v2/projects/:project/graph 响应的独立 planningTodos 字段读取根 engine.legion 内存快照；没有新增 API 路径、修改接口或持久化。
- Store.graph、projectFgs、Worker read_graph / read_graph_delta、FGS 导出与 Goal 验收不含或不使用这个 UI 附带字段。
- 清单只读，没有勾选完成、拖拽、编辑或手动 TodoWrite。只有 Commander 维护规则不变。
- 区分“尚无阶段计划”和“当前后端尚未提供清单”，避免旧后端被误当成真实空清单。
- 明示规划进度不等于 Goal 验收，且进程重启会清空内存清单。
- 未新增额外控制机制，未改变并发、权限和执行流程；每次既有 Graph 快照只增加当前 Graph 的清单副本，开销随清单长度增长。

## 本轮修改文件

- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/index.ts
- /Users/lxy/Downloads/RedTrace/static/index.html
- /Users/lxy/Downloads/RedTrace/static/legion.css
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion-console.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/graph-api.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion-todos.test.ts

## 检查

| 检查 | 观察结果 |
|---|---|
| 修改前相关测试 | 30/30 通过 |
| 最终相关测试 | 32/32 通过（新增 UI 位置/只读和 HTTP 内存隔离两项） |
| 引擎完整回归 | 284 项，276 通过、7 项原有失败、1 跳过；失败名称与上轮完全相同 |
| 类型检查 | tsc --noEmit exit 0 |
| 格式检查 | git diff --check exit 0 |
| 桌面 / 窄屏 | 内置 IAB，1280×900 与 390×844；Todo 面板可读，窄屏面板 scrollWidth=clientWidth=285，无横向溢出 |
| 键盘 | 从“详情”经阶段计划按钮按 Enter，计划面板可见 |
| 自动刷新 | 实际 Commander TodoWrite 更新隔离内存后，页面未重载即由 1/4 更新为 2/4 |
| Graph / Project 隔离 | 打开任务 B 只显示其两条专属计划；独立任务 C 显示空态，不残留任务 A 清单 |
| 控制台 | 没有应用错误；仅有原有 Tailwind vendor 警告 |
| 回滚 / 重建 | 12 个累计文件 patch 重建一致；9 个原文件恢复 SHA 一致，3 个新增文件移除；之后重应用目标变更 |

页面非空、没有框架错误遮罩；截图和完整观察记录见 /Users/lxy/Downloads/RedTrace/docs/planner-todos-20261113/UI_BROWSER_QA.json。浏览器核验通过的是本地测试数据的真实渲染与交互，不是生产任务实测。

## 原版 / 修改版 / 回滚版

同一个 PROBE_UI.mjs、相同 Todo 输入：

- BASELINE，exit 0：TodoWrite=false; project_detail_TodoList=false; rows=0; FGS_unchanged=true
- MODIFIED，exit 0：TodoWrite=true; project_detail_TodoList=true; rows=2; FGS_unchanged=true
- ROLLBACK，exit 0：TodoWrite=false; project_detail_TodoList=false; rows=0; FGS_unchanged=true

上轮结果单独复查：TodoWrite=true; project_detail_TodoList=false。同时重新执行了原 PROBE.mjs：原版和回滚版都无 TodoWrite；修改版仍跨唤醒保留 completed,in_progress，整表替换且 FGS 不变。

## 既有四角色路径（本轮累计扩展，未更换角色）

- MODIFIED_FILE：/Users/lxy/Downloads/RedTrace/docs/planner-todos-20261113/MODIFIED_FILE.tar.gz
- DIFF_FILE：/Users/lxy/Downloads/RedTrace/docs/planner-todos-20261113/DIFF_FILE.patch
- VERIFICATION：/Users/lxy/Downloads/RedTrace/docs/planner-todos-20261113/VERIFICATION.txt
- ROLLBACK：/Users/lxy/Downloads/RedTrace/docs/planner-todos-20261113/ROLLBACK.sh

上轮各文件和完整证据保存在 /Users/lxy/Downloads/RedTrace/docs/planner-todos-20261113/history-before-ui/。ROLLBACK.sh 依赖同目录 BASELINE.tar.gz，接受目标源码副本目录，会恢复本次累计 9 个原文件并删除 3 个新增文件；不要用于含后续编辑的目录。

## 限制与下一步

未重启 8000 主服务，因为会中断会话并清空 Commander 的内存计划；主服务在任务空闲时重新加载后才能读取新的 planningTodos 字段。预览服务仅保留本地隔离夹具，未提交或推送 Git。

390px 下原项目详情顶部旧控制条仍有换行/裁切，未扩大范围重排全部旧控件；本次新增计划面板和入口已适配窄屏。不宣称整个移动端界面已全面优化。DSH 源码本轮未改，未重复完整 DSH 构建；上一轮完整构建和 58 项 DSH 测试通过的证据保留。
