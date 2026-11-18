/** REA is CLI-only; the native Skill adds no model Tool Schemas or MCP process. */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { mount, repoRoot } from './loader.js'
export const name = 'redtrace-reverse-session'
export const inject = ['skills', 'shellEnv', 'systemPrompt']
export const REA_VERSION = '6.4.0'
export function reverseEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = { REA_MCP_INPUT_SCHEMA_PROFILE: 'compact' }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && /^(REA_|GHIDRA_INSTALL_DIR$|JAVA_HOME$|HOPPER_)/.test(key)) result[key] = value
  }
  if (!result.GHIDRA_INSTALL_DIR) {
    const root = [env.GHIDRA_HOME, '/opt/homebrew/opt/ghidra/libexec', '/usr/local/opt/ghidra/libexec']
      .find(dir => dir && existsSync(path.join(dir, 'support/analyzeHeadless')))
    if (root) result.GHIDRA_INSTALL_DIR = root
  }
  if (!result.JAVA_HOME) {
    const root = ['/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home', '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home']
      .find(dir => existsSync(path.join(dir, 'bin/java')))
    if (root) result.JAVA_HOME = root
  }
  return result
}

export async function apply(ctx: any): Promise<void> {
  const bin=path.join(repoRoot,'node_modules/.bin')
  if(!(process.env.PATH??'').split(path.delimiter).includes(bin))process.env.PATH=bin+path.delimiter+(process.env.PATH??'')
  await mount(ctx,'vendor/deepseek-harness/packages/skill/skill-filesystem/lib/index.js',{
    providerName:'redtrace-reverse',includeDefaultRoots:false,customSkillDirs:[path.join(repoRoot,'plugins/reverse/skills')],watch:false,
  })
  ctx.shellEnv.register({name:'redtrace-reverse',variables:{DSH_REA_CLI:{description:'Pinned REA CLI path'}},resolve:()=>({DSH_REA_CLI:path.join(repoRoot,'node_modules/rea-agents/scripts/rea.mjs')})})
  ctx.systemPrompt.section({name:'redtrace:rea-cli',order:3,interpolate:false,text:'REA is CLI-only: load reverse-engineer-anything and use rea --help through the native shell. Never call or start REA MCP tools. No CLI script is a Tool Schema.'})
}
