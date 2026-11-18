/** Only session-scoped task features belong here; never kernels or global services. */
export const TASK_PLUGINS = [{
  id: 'redtrace-reverse', label: 'Reverse Engineering',
  modulePath: 'packages/redtrace-dsh/lib/reverse.js',
  description: '按需逆向 ELF/PE、APK、JS、托管代码与固件',
  intro: '默认开启，仅通过 Skill 和原生 Shell 使用官方 REA CLI；不注册 MCP 工具、不启动 MCP。管理器停止禁用此 Skill，不取消 Step。',
}] as const
