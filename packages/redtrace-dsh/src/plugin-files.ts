import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

/** path.relative also handles case-insensitive Windows drive paths. */
function contains(directory: string, target: string): boolean {
  const relative = path.relative(directory, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function missing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

async function canonical(target: string): Promise<string> {
  try { return await realpath(target) }
  catch (error) {
    if (missing(error)) return path.resolve(target)
    throw error
  }
}

/** Only a top-level managed package (or flat file) is owned by an installation.
 * Shared packages and source modules elsewhere in the repository stay intact. */
export async function userPluginFiles(
  root: string,
  module: string,
  otherModules: readonly string[],
  manifestPath: string,
): Promise<string | null> {
  const directory = path.resolve(root, 'plugins')
  const target = path.resolve(root, module)
  if (!contains(directory, target) || path.relative(directory, target) === '') return null
  const victim = path.join(directory, path.relative(directory, target).split(path.sep)[0])
  for (const location of [directory, victim]) {
    try {
      if ((await lstat(location)).isSymbolicLink()) throw new Error('不能删除符号链接或目录联接中的插件，请先移回 plugins/ 独立目录')
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }
  const resolved = await canonical(victim)
  if (contains(resolved, await canonical(manifestPath))) throw new Error('插件目录包含管理配置，不能删除')
  for (const other of otherModules) {
    if (contains(victim, path.resolve(root, other)) || contains(resolved, await canonical(path.resolve(root, other)))) return null
  }
  return victim
}
