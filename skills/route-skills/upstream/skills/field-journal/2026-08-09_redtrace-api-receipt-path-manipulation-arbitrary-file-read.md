# 当 API 响应暴露服务端文件路径字段（如 receipt_path），且更新接口未校验该字段权限时，可通过追加该参数覆盖路径，结合下载接口实现任意文件读取

## 攻击模式
1. 侦察阶段关注 API JSON 响应中的路径字段（如 receipt_path、avatar_path、attachment_path）
2. 测试更新接口是否接受额外表单字段（FormData 可追加未在 HTML 表单中声明的参数）
3. 若成功覆盖路径，再通过对应的下载/查看端点读取目标文件

## 关键信号
- 响应 JSON 含绝对路径字段
- 更新接口使用 FormData/multipart 且无严格字段白名单
- 存在独立的文件下载端点（如 download.php?id=X）

## 利用步骤
- 创建资源触发路径字段回显
- 调用 update 接口追加目标路径参数
- 通过 download 端点读取

## 已脱敏验证实例
- 目标：PHP 报销系统 update_ticket.php，追加 receipt_path 参数覆盖为 /challenge/flag.txt，download.php 读取返回 flag
