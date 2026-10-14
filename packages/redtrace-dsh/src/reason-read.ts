/** Reason-only full-file reads; Execute keeps the native bounded read tool. */
import { load } from './loader.js'

export const name = 'redtrace-reason-read'
export const inject = ['tools', 'fs', 'systemPrompt', 'workingDirectory']

interface ReadValue {
  path: string
  offset: number
  lines: { number: number; text: string }[]
  totalLines: number
}

export async function apply(ctx: any): Promise<void> {
  const { FsError } = await load('vendor/deepseek-harness/packages/fs/fs/lib/index.js')
  const native = ctx.tools.get('read')
  if (!native) throw new Error('Reason requires the native read tool')
  ctx.tools.register({
    ...native,
    description: 'Read a UTF-8 text file in full by default, with optional offset/limit and no path or output-size cap.',
    parameters: { ...native.parameters, properties: { ...native.parameters.properties,
      limit: { type: 'number', description: 'Optional number of lines to return. Omitted reads through end of file.' },
    } },
    output: { ...native.output, render: (_args: unknown, value: ReadValue) => {
      const end = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1)
      const footer = end < value.totalLines
        ? `(Showing lines ${value.offset}-${end} of ${value.totalLines}. Use offset=${end + 1} to continue.)`
        : `(End of file - total ${value.totalLines} lines)`
      const body = value.lines.length ? `${value.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}` : footer
      return [{ type: 'text', text: `<path>${value.path}</path>\n<type>file</type>\n<content>\n${body}\n</content>` }]
    } },
    async execute(args: { file_path: string; offset?: number; limit?: number }, exec: any): Promise<ReadValue> {
      if (!args.file_path.trim()) throw new Error('file_path must be a non-empty string')
      for (const key of ['offset', 'limit'] as const) {
        const value = args[key]
        if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`${key} must be a positive integer`)
      }
      const cwd = exec.agent ? await ctx.workingDirectory.ensure(exec.agent, exec.signal) : undefined
      const target = await ctx.fs.resolve(args.file_path, { cwd, signal: exec.signal })
      const info = await ctx.fs.stat(target, exec.signal)
      if (!info) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      const text = await ctx.fs.readText(target, exec.signal)
      const lines: string[] = text ? text.split('\n') : []
      if (text.endsWith('\n')) lines.pop()
      const offset = args.offset ?? 1
      if (offset > lines.length && !(lines.length === 0 && offset === 1)) throw new FsError(`offset ${offset} is out of range for "${target.displayPath}" (${lines.length} lines)`, 'FS_NOT_FOUND')
      const selected = lines.slice(offset - 1, args.limit === undefined ? undefined : offset - 1 + args.limit)
      exec.signal.throwIfAborted()
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return { path: ctx.fs.processPath(target), offset, totalLines: lines.length,
        lines: selected.map((text, index) => ({ number: offset + index, text: text.endsWith('\r') ? text.slice(0, -1) : text })),
      }
    },
  })
  ctx.systemPrompt.section({ name: 'tool:read', order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
    text: 'Use read to inspect UTF-8 text files. It returns the complete file by default, without path, line, character or byte caps. Use offset/limit only when you intentionally want a partial read.',
  })
}
