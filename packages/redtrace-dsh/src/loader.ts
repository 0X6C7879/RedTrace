import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import type { CordisFiber, ScopedContext } from './types.js'

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** Load a module from the DSH harness or this repository by repo-relative path. */
export async function load(relative: string): Promise<any> {
  return import(pathToFileURL(path.join(repoRoot, relative)).href)
}

/** Mount a plugin by repo-relative module path and wait for its fiber. */
export async function mount(
  scoped: ScopedContext,
  relative: string,
  config?: Record<string, any>,
): Promise<void> {
  try {
    const module = await load(relative) as { default?: unknown }
    await scoped.plugin(module.default ?? module, config).await()
  } catch (error) {
    throw new Error(`failed to mount ${relative}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
