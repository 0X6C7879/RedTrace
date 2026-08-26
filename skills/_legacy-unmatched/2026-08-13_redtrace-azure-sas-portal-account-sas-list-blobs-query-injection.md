# Azure Blob Storage SAS 门户账户级 SAS 列表注入

## 场景
云存储（Azurite）门户提供「生成临时访问凭证」功能，并对存储后端做单 blob 读取代理。门户只暴露容器列表与单 blob 读取，不暴露 list-blobs，但 flag 存在于某个容器内未知名称的 blob 中。

## 关键技巧

### 1. 账户级 SAS 过度授权
- `/sas/generate` 返回账户级 SAS：`sp=rwdlac&ss=b&srt=sco&sv=...`。`srt=sco` 表示签名不绑定具体 container/blob，可对账户内任意资源执行 list/read/write/delete。
- 判断依据：该 SAS 对「存在的容器读不存在 blob」返回 BlobNotFound、对「不存在的容器」返回 ContainerNotFound，即可用错误码区分容器存在性；同时签名可复用于任意容器。

### 2. 代理端点字符串拼接 URL 的列表注入
- 代理端点形如 `/sas/<container>/<blob>?sas=<token>`，后端用 f-string 拼接：`{endpoint}/{container}/{blob}?{sas}`，container/blob 为路由解码后的原始值、未做 URL 编码/过滤。
- 常规做法（把 `restype=container&comp=list` 直接塞进 sas 或路径）会因路径含 blob 段被 azurite 当作单 blob 读，或 `?` 提前截断查询导致 `se` 参数被吞、签名校验失败。
- 正确注入：blob 设为 `?restype=container&comp=list&junk`，sas 参数设为 `&` + 原 SAS token。拼接后：
  `/devstoreaccount1/{container}/?restype=container&comp=list&junk?&se=..&sp=..&sv=..&ss=b&srt=sco&sig=..`
  解析后 `restype=container`、`comp=list` 触发 List Blobs；无害参数 `junk?`（空值）吸收拼接处的 `?`；`se/sp/sv/ss/srt/sig` 全部保持原样，SAS 校验通过，返回 XML 枚举结果。
- 从枚举结果 `<Name>` 标签提取 blob 名后，逐个用正常读取端点读内容即可拿到 flag。

## 复用要点
- 见到「临时凭证门户 + 单资源读取代理」，先看凭证是否账户级（`srt=sco`/`s`），再找代理端点的 URL 拼接点。
- 列表注入的核心是「用无害占位参数吸收拼接产生的 `?`，用前置 `&` 保持签名参数原样」：`blob=?restype=container&comp=list&junk` + `sas=&<token>`。
- 记下 azurite 错误码区分法：ContainerNotFound（容器不存在）vs BlobNotFound（容器存在、blob 不存在）可做容器/资源存在性探测。
