import { accumulateUsage, eventProjection } from '../../redtrace-dsh/lib/audit.js'

/** Persist changed Run state and projected audit rows; streaming deltas remain transient. */
export function recordRunEvent(store, run, task, event) {
  const data = event.data ?? {}
  if (event.type === 'assistant/chunk' && ['text-delta', 'reasoning-delta'].includes(data.chunk?.type)) {
    for (const projected of eventProjection(task, event)) store.changes.emit('audit', run.projectId, { ...projected, project_id: run.projectId, graph_id: run.graphId, run_id: run.id })
    return
  }
  if (event.type === 'step/start') store.metricStart(run.id, `model-${data.turn}-${data.step}`, 'model')
  if (event.type === 'assistant/message' || event.type === 'step/end') store.metricEnd(run.id, `model-${data.turn}-${data.step}`)
  const starting = event.type === 'tool/call' && data.callId
  const ending = event.type === 'tool/result' && data.message?.source?.callId
  const usage = event.type === 'assistant/message' && data.usage != null
  // Lifecycle validation must succeed before projection mutates tool pairing or stream state.
  const projected = starting || ending || usage ? undefined : eventProjection(task, event)
  if (!starting && !ending && !usage && !projected.length) return
  store.transaction(() => {
    if (starting) store.toolStarted(run.id, String(starting), data, false)
    if (ending) store.toolEnded(run.id, String(ending), data)
    if (usage) {
      accumulateUsage(task, event)
      const current = store.run(run.id)
      Object.assign(current, task.usage)
      store.saveRun(current)
    }
    const events = projected ?? eventProjection(task, event)
    if (events.length) {
      const metadata = JSON.parse(store.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(run.id).data)
      store.audit(metadata, events)
    }
  })
}
