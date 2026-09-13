import type { IncomingMessage, ServerResponse } from 'node:http'
import { Check } from 'typebox/value'
import type { Static, TSchema } from 'typebox'
import { HttpError } from './types.ts'

export interface RequestContext { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; signal: AbortSignal }
type Route = { method: string; pattern: RegExp; keys: string[]; handle: (context: RequestContext) => unknown | Promise<unknown> }
export function send(res: ServerResponse, value: unknown, status = 200) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, status === 204 ? {} : { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(status === 204 ? undefined : JSON.stringify(value))
}
export async function body<T extends TSchema>(req: IncomingMessage, schema: T): Promise<Static<T>> {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(422, 'JSON body required')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new HttpError(413, 'Request body too large'); chunks.push(chunk) }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(422, 'Invalid JSON') }
  if (!Check(schema, value)) throw new HttpError(422, 'Invalid request fields')
  return value
}
export function queryNumber(url: URL, key: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER, whole = true) {
  const value = url.searchParams.has(key) ? Number(url.searchParams.get(key)) : fallback
  if (!Number.isFinite(value) || (whole && !Number.isSafeInteger(value)) || value < min || value > max) throw new HttpError(422, `Invalid ${key}`)
  return value
}
export class Router {
  private routes: Route[] = []
  add(method: string, pathname: string, handle: Route['handle']) {
    const keys: string[] = []
    const pattern = new RegExp('^' + pathname.split('/').map(part => part.startsWith(':') ? (keys.push(part.slice(1)), part.endsWith('*') ? '(.+)' : '([^/]+)') : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$')
    this.routes.push({ method, pattern, keys, handle })
  }
  handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const abort = new AbortController(), close = () => abort.abort()
    res.once('close', close)
    try {
      const url = new URL(req.url ?? '/', 'http://localhost'), pathname = url.pathname.replace(/\/$/, '') || '/'
      const candidates = this.routes.filter(route => route.pattern.test(pathname))
      const route = candidates.find(route => route.method === req.method)
      if (!route) { if (candidates.length) throw new HttpError(405, 'Method Not Allowed'); return false }
      const match = route.pattern.exec(pathname)!, params: Record<string, string> = {}
      try { route.keys.forEach((key, i) => { const value = decodeURIComponent(match[i + 1]); if ((key.endsWith('*') ? /[\\\0]/ : /[\\/\0]/).test(value)) throw new Error(); params[key.replace(/\*$/, '')] = value }) } catch { throw new HttpError(400, 'Invalid path') }
      const result = await route.handle({ req, res, url, params, signal: abort.signal })
      if (!res.headersSent) send(res, result ?? null)
      return true
    } catch (error) {
      if (res.headersSent) res.destroy()
      else send(res, { detail: error instanceof HttpError ? error.message : 'Internal server error' }, error instanceof HttpError ? error.status : 500)
      if (!(error instanceof HttpError)) console.error('Request failed:', error instanceof Error ? error.name : 'Unknown error')
      return true
    } finally { res.off('close', close) }
  }
}
