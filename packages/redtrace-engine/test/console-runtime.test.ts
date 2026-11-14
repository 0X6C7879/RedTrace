import test from 'node:test'
import assert from 'node:assert/strict'
const { runtimeCatalog } = await import(new URL('../compat/console.mjs',import.meta.url).href)

test('management inventory reads the live global and Agent tool registry, including Commander restrictions',()=>{
  const commander={session:{id:'commander-session'}},worker={session:{id:'worker-session'}}
  const tools={definitions:(scope?:unknown)=>scope===commander?[{name:'legion_board',description:'actual Commander tool'}]:scope===worker?[{name:'bash'},{name:'submit_fact'},{name:'mcp__echo__echo'}]:[{name:'read'}]}
  const value=runtimeCatalog({get:(name:string)=>name==='tools'?tools:{list:()=>[commander,worker]}})
  assert.ok(value.tools.some((t:any)=>t.name==='legion_board'&&t.scope==='commander-session'&&t.source==='RedTrace'))
  assert.ok(value.tools.some((t:any)=>t.name==='mcp__echo__echo'&&t.source==='MCP'))
  assert.ok(!value.tools.some((t:any)=>t.name==='bash'&&t.scope==='commander-session'))
})
