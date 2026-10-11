/** Only session-scoped task features belong here; never kernels or global services. */
export const TASK_PLUGINS = [{
  id: 'redtrace-reverse', label: 'Reverse Engineering',
  modulePath: 'packages/redtrace-dsh/lib/reverse.js',
  description: '按需逆向 ELF/PE、APK、JS、托管代码与固件',
  intro: 'Reason 在 Step.plugins 声明后，仅该 Step 的 Explore Run 可加载官方 REA Skill、CLI 与按需 MCP。默认不装载；管理器停止为强制禁用，启动解除禁用但不向无关 Run 装载。加载 Skill 才建立 MCP，分析才启动引擎；Run 结束清理，保留已保存证据。通用 Shell 不受系统级限制。',
}] as const
