import { isReportStep } from '../../redtrace-dsh/src/roles.ts'
import { readRunTrace } from './run-trace.ts'
import { Type } from 'typebox'
import type { TaskContext } from './scheduler.ts'
import type { AgentTool } from './tool-types.ts'
import type { Finding, Step } from './types.ts'
import { HttpError, requiredText } from './types.ts'
import { ProjectEvidence } from './project-evidence.ts'

/** Optional Worker report delivery, using existing FGS Run/audit/Artifact records. */
export function reporterTools(context: TaskContext, finish: () => void): AgentTool[] {
  const { store, run, config } = context
  return [
    { name: 'read_execution', label: 'read_execution', description: "按 run_id 列 producer Run/精简 Trace，query 定位；引用前以 run_id+event_id 核对完整原始命令/结果。Fact evidence.runId/toolCallId 定位证明，不补造缺失输出。", parameters: Type.Object({ run_id: Type.Optional(Type.String()), before: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), query: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), event_id: Type.Optional(Type.Integer({ minimum: 1 })) }), executionMode: 'sequential',
      async execute(_id, args: { run_id?: string; before?: number; limit?: number; query?: string; event_id?: number }) {
        const limit = args.limit ?? 100, before = args.before ?? Number.MAX_SAFE_INTEGER
        let value: unknown
        if (!args.run_id) {
          const rows = store.db.prepare("SELECT rowid,data FROM audit_runs WHERE project_id=? AND (? IS NULL OR json_extract(data,'$.graph_id')=?) AND (?=0 OR json_extract(data,'$.task_type')NOT IN ('planner','general')) AND rowid<? ORDER BY rowid DESC LIMIT ?").all(run.projectId, run.graphId ?? null, run.graphId ?? null, store.project(run.projectId).mode==='general'?1:0, before, limit)
          value = { runs: rows.map(row => ({ ...JSON.parse(String(row.data)), cursor: Number(row.rowid) })), nextBefore: rows.length === limit ? Number(rows.at(-1)!.rowid) : null }
        } else {
          const producer = store.db.prepare('SELECT data FROM audit_runs WHERE project_id=? AND id=?').get(run.projectId, args.run_id)
          if (!producer || JSON.parse(String(producer.data)).graph_id !== run.graphId || store.project(run.projectId).mode==='general' && JSON.parse(String(producer.data)).task_type==='planner' || store.project(run.projectId).mode==='general' && JSON.parse(String(producer.data)).task_type==='general') throw new HttpError(404, 'Producer Run not in this Graph')
          value = readRunTrace(store,run.projectId,args.run_id,{before,limit:args.limit??30,query:args.query,eventId:args.event_id},run.graphId??undefined)
        }
        const text=JSON.stringify(value)
        return { content: [{ type: 'text', text }], details: JSON.parse(text) }
      } },
    { name: 'update_finding_report', label: 'update_finding_report', description: "保存 hash 寻址 Markdown Artifact 并关联本 Finding；expectedVersion 用实际读取版本。普通 Worker 保存后继续，report-only Step 保存后结束；不造证据。", parameters: Type.Object({ finding_id: Type.String(), expectedVersion: Type.Integer({ minimum: 1 }), report: Type.String({ minLength: 1 }) }), executionMode: 'sequential',
      async execute(_id, args: { finding_id: string; expectedVersion: number; report: string }) {
        const step = store.node<Step>(run.projectId, run.stepId!, 'step')
        if (!(step.reportFindingId===args.finding_id || step.sourceIds.includes(args.finding_id) || store.project(run.projectId).mode==='general'&&store.node<Finding>(run.projectId,args.finding_id,'finding').stepId===step.id)) throw new HttpError(403, 'Worker cannot update another Finding')
        const finding = store.node<Finding>(run.projectId, args.finding_id, 'finding')
        const storage = new ProjectEvidence(store, config.workspaceRoot)
        const artifact = storage.publish(run.projectId, Buffer.from(requiredText(args.report, 'report')), { description: finding.title+' — report.md', runId: run.id })
        const saved = store.updateFindingReport(run.projectId, finding.id, { artifactId: artifact.id, description: finding.title+' — report.md', runId: run.id }, args.expectedVersion, run.id)
        if(isReportStep(step))finish()
        const value = { findingId: saved.id, report: saved.report }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, ...(isReportStep(step)?{terminate:true}:{}) }
      } },
  ]
}
