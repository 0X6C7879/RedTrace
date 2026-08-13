# JDWP 调试端口 RCE 输出回读（已验证）

## 背景
暴露的 JDWP 调试端口（如 OpenJDK 17）可直接远程执行任意 JVM 方法，无需任何凭据。
经典 jdwp-shellifier 只能证明 Runtime.exec() 成功（拿到 Process 对象），无法回读命令输出。

## 关键点

1. **断点必须选 NIO 的 accept**：Jetty 9 等 NIO 服务器走 ServerSocketChannel，
   `java.net.ServerSocket.accept` 断点永不命中，必须用
   `sun.nio.ch.ServerSocketChannelImpl.accept`（SUSPEND_ALL）。
   命中后在该挂起线程上 invoke，断点由任意一次对目标 HTTP 端口的连接触发。

2. **输出回读链路（已验证有效）**：
   `Runtime.exec(cmd)` → `Process.getInputStream()` → `InputStream.readAllBytes()`
   → `ArrayReference.Length` + `ArrayReference.GetValues` 取出 byte[] 原文。
   - 不要用 `Scanner(InputStream)` 的 `ClassType.NewInstance`，会返回 0 字节空回包。
   - `Files.readString(Paths.get(path))` + `StringReference.Value` 可作备选直读文件，
     但需注意 Paths.get/readString 存在 varargs/Charset 重载，invoke 时必须选对重载签名。

3. **Python3 实现要点**：jdwp-shellifier 原版为 py2，2to3 后 bytes/str 混用会残缺；
   需自写 py3 客户端，全程 bytes + struct，ID 尺寸由 IDSIZES 命令动态读取（OpenJDK 17 全为 8）。

4. 成功执行后记得 `ResumeVM`，否则 VM 保持 SUSPEND_ALL 冻结，目标 HTTP 服务会停止应答
   （调试器断开时不一定自动恢复）。

## 验证结果
对 OpenJDK 17.0.2（GeoServer/Jetty 场景）实测：`id`、`ls`、`cat` 均能回读完整输出，
成功读取挑战 flag 文件并提交通过。
