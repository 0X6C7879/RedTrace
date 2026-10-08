import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Type } from 'typebox'
import { body, send } from './http.ts'
import type { Router } from './http.ts'
import type { Scheduler } from './scheduler.ts'
import { HttpError } from './types.ts'

function updateErrorSummary(error: string) {
  const lines = error.split('\n').map(line => line.trim()).filter(line => line && !/^at\s/.test(line))
  const cause = lines.find(line => /\b(?:[A-Za-z]*Error|ERROR)\b|Cannot find/.test(line)) ?? lines[0]
  return [...new Set([cause, lines.at(-1)])].filter(Boolean).join('\n').slice(0, 500)
}

export async function dshUpdateRoutes(router: Router, root: string, scheduler: Scheduler) {
  const codeRoot = path.resolve(process.env.REDTRACE_CODE_ROOT || root)
  const filename = path.join(codeRoot, 'vendor/deepseek-harness/package.json')
  // The updater rewrites package.json in place; a read that lands inside the
  // truncated window sees empty/partial JSON, so retry instead of failing the
  // snapshot (UI polls this endpoint continuously during an update).
  const version = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return JSON.parse(await readFile(filename, 'utf8')).version as string }
      catch (error: any) {
        if (error.code === 'ENOENT') return null
        if (attempt >= 5) return null
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
  }
  const runningVersion = await version()
  let latest: { version: string; tag: string; url: string } | null = null
  let job: { state: 'idle' | 'running' | 'succeeded' | 'failed'; message: string; backup?: string } = { state: 'idle', message: '' }
  let completion: Promise<void> | undefined
  const snapshot = async () => { const installedVersion = await version(); return { runningVersion, installedVersion, latest, ...job, restartRequired: runningVersion !== installedVersion } }
  router.add('GET', '/runtime/dsh', async c => {
    if (c.url.searchParams.get('check') === '1') {
      try {
        const updater = await import(pathToFileURL(path.join(root, 'scripts/update-dsh.mjs')).href)
        latest = await updater.latestRelease()
      } catch { throw new HttpError(502, '无法检查 DSH 更新，请检查 GitHub 网络连接后重试') }
    }
    return snapshot()
  })
  router.add('POST', '/runtime/dsh/update', async c => {
    const origin = c.req.headers.origin
    if (origin) {
      let host: string
      try { host = new URL(origin).host } catch { throw new HttpError(403, 'Cross-origin update rejected') }
      if (host !== c.req.headers.host) throw new HttpError(403, 'Cross-origin update rejected')
    }
    await body(c.req, Type.Object({}, { additionalProperties: false }))
    if (!runningVersion) throw new HttpError(409, '当前目录没有 DSH 源码，无法更新')
    if (codeRoot !== root) throw new HttpError(409, '独立运行目录请在源码目录执行 npm run dsh:update 后重新部署')
    if (job.state === 'running') throw new HttpError(409, 'DSH 更新正在进行')
    if ((await snapshot()).restartRequired) throw new HttpError(409, '请先重启 RedTrace，使已安装的 DSH 生效')
    if (scheduler.activeRuns.length) throw new HttpError(409, '还有 Worker 正在运行，请等待任务结束后更新 DSH')
    scheduler.maintenance = true
    job = { state: 'running', message: '正在下载、构建并验证 DSH；调度已暂停' }
    const child = spawn(process.execPath, [path.join(root, 'scripts/update-dsh.mjs'), '--root', root], { cwd: root, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` }, stdio: ['ignore', 'pipe', 'pipe'] })
    let result: { changed: boolean; version: string; backup?: string } | undefined, pending = '', lastError = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      pending += chunk
      const lines = pending.split('\n'); pending = lines.pop()!
      for (const line of lines) {
        if (line.startsWith('DSH_UPDATE_RESULT ')) { try { result = JSON.parse(line.slice(18)) } catch { /* A missing result is treated as failure. */ } }
        else {
          const stages = { Downloading: '正在下载新版 DSH', Preparing: '正在准备运行时并保留本地补丁', Installing: '正在安装依赖', Building: '正在构建新版 DSH', Checking: '正在验证兼容性' }
          const stage = Object.keys(stages).find(stage => line.startsWith(stage)) as keyof typeof stages | undefined
          if (stage) job.message = stages[stage]
        }
      }
    })
    child.stderr.on('data', (chunk: string) => { lastError = (lastError + chunk).slice(-64000) })
    completion = new Promise<void>(resolve => {
      let finished = false
      const finish = (error?: string) => {
        if (finished) return; finished = true
        job = error ? { state: 'failed', message: `更新失败，当前版本保留：${updateErrorSummary(error)}` }
          : { state: 'succeeded', message: result!.changed ? `DSH ${result!.version} 已安装，请重启 RedTrace 后继续任务` : 'DSH 已是最新版本', backup: result!.backup }
        scheduler.maintenance = !error && !!result?.changed
        if (!scheduler.maintenance) scheduler.wake()
        resolve()
      }
      child.once('error', error => finish(error.message))
      child.once('close', code => finish(code === 0 && result ? undefined : lastError.trim() || `更新程序退出 (${code})`))
    })
    send(c.res, await snapshot(), 202)
  })
  return { async close() { await completion } }
}
