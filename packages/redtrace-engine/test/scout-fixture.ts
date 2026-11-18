/** Prior completed reconnaissance fixture for tests of downstream lifecycle/capacity only.
 * Full Scout -> Fact -> successful completion -> classification is exercised by benchmark-autonomy. */
import type {LegionStore} from '../src/legion-store.ts'
export function scoutedSpawn(legion:LegionStore, ...args:Parameters<LegionStore['spawn']>) {
 const [projectId,mission]=args
 const row=legion.store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId,mission.taskKey)
 const data=row?JSON.parse(String(row.data)):{}
 if(!data.classifiedAt)legion.store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?) ON CONFLICT(project_id,task_key) DO UPDATE SET data=excluded.data').run(projectId,mission.taskKey,JSON.stringify({...data,difficulty:'easy',classifiedAt:'2026-01-01T00:00:00Z',factIds:['fixture-prior-scout-proof']}))
 return legion.spawn(...args)
}
