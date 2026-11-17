import assert from 'node:assert/strict'
import test from 'node:test'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'

test('new CyBench task starts a Soldier without a Scout gate and reinforces by evidence', t => {
  const store=new Store(':memory:'),project=store.createProject({mode:'benchmark',title:'CyBench dispatch',origin:'Authorized CyBench fixture',goal:'verify task'}).project
  const legion=new LegionStore(store,project.id);t.after(()=>store.close())
  const graph=store.createGraph(project.id,{taskKey:'CYBENCH-001',title:'NoisierCRC',origin:'An AES-CTR and polynomial oracle challenge',goal:'recover the flag'})
  const mission=(role:'scout'|'soldier'|'general',description:string)=>({role,taskKey:'CYBENCH-001',graphId:graph.id,goalId:graph.goalId,description,sourceIds:[graph.originId]})
  store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?)').run(project.id,'CYBENCH-001',JSON.stringify({platformCompleted:false}))
  const initial=legion.spawn(project.id,mission('soldier','initial independent exploration'));assert.equal(initial.role,'soldier');store.updateStep(project.id,initial.id,{status:'cancelled'})
  const scout=legion.spawn(project.id,mission('scout','classify the oracle'))
  assert.throws(()=>legion.spawn(project.id,mission('scout','classify the oracle')),/different angle/)
  const scoutRun=store.claim(project.id,'execute',{name:'fixture',backend:'mock'},scout.id)
  const fact=store.forGraph(project.id,graph.id).addFact(project.id,'oracle requires algebra',{runId:scoutRun.id,evidence:[{description:'task description names CRC-16 and AES-CTR'}]})
  store.finishRun(scoutRun.id,'succeeded')
  legion.classify(project.id,'CYBENCH-001','medium',[fact.id])
  const complex=legion.spawn(project.id,{...mission('general','complex algebra chain'),escalationReason:'known multi-stage oracle algebra'});assert.equal(complex.role,'general');store.updateStep(project.id,complex.id,{status:'cancelled'})
  const first=legion.spawn(project.id,mission('soldier','analyze CRC oracle'))
  const firstRun=store.claim(project.id,'execute',{name:'fixture',backend:'mock'},first.id)
  assert.throws(()=>legion.spawn(project.id,mission('soldier','analyze CRC oracle')),/different angle/)
  for(const run of [scoutRun,firstRun]){run.startedAt=new Date(Date.now()-11*60000).toISOString();store.saveRun(run);store.db.prepare("UPDATE events SET created_at=? WHERE type='execute.started' AND json_extract(data,'$.runId')=?").run(run.startedAt,run.id)}
  store.db.prepare("UPDATE events SET created_at=? WHERE node_id=? AND type='fact.added'").run(new Date(Date.now()-11*60000).toISOString(),fact.id)
  assert.equal(legion.tactics(project.id)[0].recommendation,'second-angle')
  const second=legion.spawn(project.id,mission('soldier','independent polynomial angle'))
  assert.equal(second.role,'soldier')
  for(const run of [scoutRun,firstRun]){run.startedAt=new Date(Date.now()-21*60000).toISOString();store.saveRun(run);store.db.prepare("UPDATE events SET created_at=? WHERE type='execute.started' AND json_extract(data,'$.runId')=?").run(run.startedAt,run.id)}
  store.db.prepare("UPDATE events SET created_at=? WHERE node_id=? AND type='fact.added'").run(new Date(Date.now()-21*60000).toISOString(),fact.id)
  assert.equal(legion.tactics(project.id)[0].recommendation,'general')
  assert.equal(legion.spawn(project.id,mission('general','coordinate hard algebra chain')).role,'general')
})

test('hard CyBench verdict uses General; unclear verdict funds another Scout', t => {
  const store=new Store(':memory:'),project=store.createProject({mode:'benchmark',title:'CyBench roles',origin:'Authorized CyBench fixture',goal:'verify task'}).project
  const legion=new LegionStore(store,project.id);t.after(()=>store.close())
  for(const [key,verdict] of [['CYBENCH-002','hard'],['CYBENCH-003','unclear']] as const){
    const graph=store.createGraph(project.id,{taskKey:key,title:key,origin:'local challenge',goal:'verify'})
    const mission=(role:'scout'|'soldier'|'general')=>({role,taskKey:key,graphId:graph.id,goalId:graph.goalId,description:role+' distinct angle',sourceIds:[graph.originId]})
    const scout=legion.spawn(project.id,mission('scout')),run=store.claim(project.id,'execute',{name:'fixture',backend:'mock'},scout.id)
    const fact=store.forGraph(project.id,graph.id).addFact(project.id,'classification evidence',{runId:run.id,evidence:[{description:'verified local fixture'}]})
    store.finishRun(run.id,'succeeded');legion.classify(project.id,key,verdict,[fact.id])
    assert.equal(legion.spawn(project.id,mission('soldier')).role,'soldier','verdict guides strategy without an additional execution gate')
    if(verdict==='hard')assert.equal(legion.spawn(project.id,mission('general')).role,'general')
    else assert.equal(legion.spawn(project.id,mission('scout')).role,'scout')
  }
})
