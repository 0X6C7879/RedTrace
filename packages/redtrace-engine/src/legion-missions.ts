import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { rewriteToolNames } from '../../redtrace-dsh/src/tool-domains.ts'
import type { FixedRole } from '../../redtrace-dsh/src/roles.ts'
import type { LegionRole } from './types.ts'

const native = createRequire(import.meta.url)('./native/redtrace_native.node') as {
  legionMission(role: string, mode: string, planning: boolean, platform: string, assets: string[]): string
  activityPrompt(role: string, mode: string, planning: boolean, platform: string, assets: string[], assignment?: {projectId:string;graphId:string;taskKey:string;specialist?:string;bootstrap:boolean;reporting:boolean}): string
}
const missionAssets = ['sapper-fact-layers','benchmark-commander','general-planner','reporter'].map(name => readFileSync(new URL('../prompts/'+name+'.md', import.meta.url), 'utf8'))
export const reportWorkflowPrompt = rewriteToolNames(missionAssets[3])
/** DSH owns the Session; native Rust owns the role-specific mission and assignment projection. */
export const legionMission = (role: LegionRole | FixedRole, mode: 'benchmark' | 'general' = 'benchmark', planning = true) => native.legionMission(role, mode, planning, process.platform, missionAssets)
export const missionPrompt = (role: string, mode: string, planning: boolean, assignment?: {projectId:string;graphId:string;taskKey:string;specialist?:string;bootstrap:boolean;reporting:boolean}) => native.activityPrompt(role, mode, planning, process.platform, missionAssets, assignment)
