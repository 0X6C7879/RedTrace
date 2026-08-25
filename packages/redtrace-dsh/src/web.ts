/**
 * RedTrace Web plugin: the Cordis web server owns the Web layer — it serves
 * the RedTrace UI static assets directly (no proxy hop) and forwards API
 * requests to the RedTrace FastAPI server. This is the Cordis-Web serving
 * seam; the domain API stays with RedTrace until it converges onto Cordis
 * plugins too.
 * @module redtrace-web
 */

import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import path from 'node:path'
import type { RuntimeContext } from './types.js'
import { state } from './state.js'

export const name = 'redtrace-web'
export const inject = ['webServer']

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function sendFile(res: any, file: Buffer, pathname: string): void {
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(pathname).toLowerCase()] ?? 'application/octet-stream',
    'content-length': file.length,
    'cache-control': 'no-cache',
  })
  res.end(file)
}

function sendNotFound(res: any): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

export function apply(ctx: RuntimeContext): void {
  const shared = state()
  const server = shared?.config.server
  const webServer = ctx.webServer ?? ctx.get('webServer') as RuntimeContext['webServer'] | undefined
  if (webServer === undefined || server === undefined) return

  webServer.register({
    kind: 'exact',
    path: '/__redtrace/runtime',
    handler: (_req, res) => {
      const isolation = process.platform === 'win32'
        ? 'windows-acl-partial' : process.platform === 'darwin' ? 'seatbelt' : 'bwrap-landlock'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ engine: 'dsh', isolation, session_source: 'dsh-jsonl' }))
    },
  })

  // The Web layer: static UI assets served straight from the Cordis server.
  const config = shared!.config as { root: string; staticDir?: string }
  const staticDir = path.resolve(
    config.staticDir ?? path.join(config.root, 'redtrace', 'src', 'redtrace', 'server', 'static'),
  )
  // Cache-busting query strings (e.g. operations.js?v=...) are part of the
  // request URL, not the file name, so they must be dropped before resolving.
  const serveAsset = async (res: any, pathname: string): Promise<void> => {
    const requestPath = pathname.split('?')[0]
    const relative = requestPath.replace(/^\/static\/?/, '')
    const target = path.resolve(staticDir, relative)
    if (!target.startsWith(`${staticDir}${path.sep}`) || relative === '') {
      sendNotFound(res)
      return
    }
    try {
      sendFile(res, await readFile(target), requestPath)
    } catch {
      sendNotFound(res)
    }
  }
  webServer.register({
    kind: 'prefix',
    path: '/static',
    handler: (req: any, res: any) => {
      void serveAsset(res, String(req.url ?? ''))
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/',
    handler: (_req: any, res: any) => {
      void serveAsset(res, '/static/index.html')
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/favicon.svg',
    handler: (_req: any, res: any) => {
      void serveAsset(res, '/static/favicon.svg')
    },
  })

  // The domain API stays with the RedTrace FastAPI server for now.
  const target = new URL(server)
  webServer.registerFallback((req, res) => new Promise<void>((resolve, reject) => {
    const headers = { ...req.headers, host: target.host }
    for (const name of ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
      delete headers[name]
    }
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
    }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
      response.once('end', resolve)
    })
    upstream.once('error', reject)
    req.pipe(upstream)
  }))
}
