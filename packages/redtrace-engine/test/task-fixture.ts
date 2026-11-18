/** Routing setup for tests of downstream lifecycle/capacity. Direct routing is tested separately. */
import type {LegionStore} from '../src/legion-store.ts'
export function spawnTask(legion:LegionStore, ...args:Parameters<LegionStore['spawn']>) {
 const [projectId,mission]=args
 if(mission.role==='general') {
  const row=legion.store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId,mission.taskKey)
  const data=row?JSON.parse(String(row.data)):{}
  legion.store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?) ON CONFLICT(project_id,task_key) DO UPDATE SET data=excluded.data').run(projectId,mission.taskKey,JSON.stringify({...data,platformMetadata:{...data.platformMetadata,flag_count:2}}))
 }
 return legion.spawn(...args)
}
