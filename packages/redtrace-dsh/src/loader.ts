import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import type { CordisFiber, ScopedContext } from './types.js'

export const repoRoot = path.resolve(process.env.REDTRACE_SOURCE_ROOT || fileURLToPath(new URL('../../../', import.meta.url)))
const codeRoot = path.resolve(process.env.REDTRACE_CODE_ROOT || repoRoot)

/** Load a module from the DSH harness or this repository by repo-relative path. */
export async function load(relative: string): Promise<any> {
  const root = relative.startsWith('vendor/deepseek-harness/') ? codeRoot : repoRoot
  return import(pathToFileURL(path.join(root, relative)).href)
}

/** Mount a plugin by repo-relative module path and wait for its fiber.
 * Returns the fiber so callers can dispose the mount later. */
export async function mount(
  scoped: ScopedContext,
  relative: string,
  config?: Record<string, any>,
): Promise<CordisFiber> {
  try {
    const module = await load(relative) as { default?: unknown }
    const fiber = scoped.plugin(module.default ?? module, config)
    await fiber.await()
    return fiber
  } catch (error) {
    throw new Error(`failed to mount ${relative}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
