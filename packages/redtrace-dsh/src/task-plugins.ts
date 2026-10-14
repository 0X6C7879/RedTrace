/** Only session-scoped task features belong here; never kernels or global services. */
export const TASK_PLUGINS = [{
  id: 'redtrace-reverse', label: 'Reverse Engineering',
  modulePath: 'packages/redtrace-dsh/lib/reverse.js',
  description: '按需逆向 ELF/PE、APK、JS、托管代码与固件',
  intro: '默认开启，由 Explore 按需加载官方 REA Skill、CLI 与原生 MCP。管理器停止为强制禁用，不取消 Step；Skill 加载才建立 MCP，分析才启动引擎，Run 结束清理连接并保留证据。',
}] as const
