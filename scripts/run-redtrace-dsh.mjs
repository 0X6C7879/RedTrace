import { boot, installFailLoud, loadEnv } from '../vendor/deepseek-harness/packages/boot/app-boot/lib/index.js'

const name = 'redtrace-dsh'
installFailLoud(name)
loadEnv(name)

const profile = process.env.DSH_CORDIS_CONFIG
if (!profile) throw new Error('DSH_CORDIS_CONFIG is required')
const ctx = await boot(name, profile)
let closing = false

async function close(code) {
  if (closing) return
  closing = true
  try {
    await ctx.fiber.dispose()
  } finally {
    process.exitCode = code
  }
}

process.on('SIGINT', () => { void close(130) })
process.on('SIGTERM', () => { void close(0) })
