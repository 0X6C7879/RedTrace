// Headless 测评镜像专用 noop Pi 扩展。
// PiDriver 默认向 pi 传 `--extension npm:pi-mcp-extension@1.5.0`；
// 本镜像按裁剪要求不安装 MCP 扩展（运行期也无 npm 网络），
// 故以容器 ENV REDTRACE_PI_MCP_EXTENSION 指向本文件兜底：
// 扩展合法存在但不注册任何能力（镜像内无任何 MCP Server 配置）。
export default function () {}
