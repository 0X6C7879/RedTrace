import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function containerHost(interfaces = networkInterfaces()) {
  // shortcut: Docker bridge uses IPv4; add scoped IPv6 selection if deployment requires it.
  const host = Object.values(interfaces).flat().find(entry => entry && entry.family === 'IPv4' && !entry.internal)?.address
  if (!host) throw new Error('Container has no concrete non-loopback IPv4 address')
  return host
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(containerHost())
