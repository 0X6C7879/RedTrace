import { randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { load } from "../lib/loader.js"
import * as query from "../lib/session-query.js"
import * as spill from "../lib/spill.js"
import { PluginManager } from "../lib/plugins.js"
import { mountReasonTools } from "../../redtrace-engine/compat/cordis.mjs"
const V = "vendor/deepseek-harness/packages"

async function host(root) {
  const { Context } = await load("vendor/deepseek-harness/vendor/cordis/lib/index.js")
  const ctx = new Context()
  for (const [module, config] of [
    [`${V}/session/session-projection/lib/index.js`],
    ["packages/redtrace-dsh/lib/core.js"],
    [`${V}/session/session-persistence-jsonl/lib/index.js`, { root, compression: "none" }],
  ]) {
    const m = await load(module)
    await ctx.plugin(m.default ?? m, config).await()
  }
  return ctx
}
async function caller(ctx, cwd, role) {
  const { createScope } = await load(`${V}/core/scope/lib/index.js`)
  const carrier = ctx.plugin({ inject: ["tools", "systemPrompt"], apply() {} })
  await carrier.await()
  const agent = { options: {}, session: ctx.sessions.create(undefined, { meta: { cwd, agentPreset: role } }) }
  const scope = createScope(carrier.ctx, agent)
  agent.ctx = scope.ctx
  if (role === "reason") await mountReasonTools(scope.ctx)
  else {
    agent.ctx = scope.ctx.isolate('spillStore')
    await agent.ctx.plugin(spill, { sessionRoot: cwd }).await()
  }
  return agent
}
let callId = 0
const call = (ctx, agent, name, args) => ctx.tools.execute({ name, arguments: args, agent, callId: `query-${++callId}`, signal: new AbortController().signal })
const text = result => result.content.map(b => b.text ?? "").join("")
const message = (session, value) => session.append("user/message", { id: randomUUID(), role: "user", source: {kind:"user"}, content: [{ type: "text", text: value }] }, { surfaceOp: "append" })

test("native five tools share a Project across roles/Workers and reject foreign Projects", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "redtrace-query-"))
  const ctx = await host(root)
  t.after(async () => { await ctx.fiber.dispose(); rmSync(root, {recursive:true,force:true}) })
  const manager = new PluginManager(ctx,{sessionRoot:root,pluginsManifest:path.join(root,"plugins.json")},root)
  assert.equal((await manager.start("redtrace-trace-search")).status,"running")
  assert.equal(existsSync(path.join(root,"session-query.sqlite")),false,"index opens only on explicit search")
  const cwd=path.join(root,"proj_001"); mkdirSync(cwd)
  const foreign=ctx.sessions.create("foreign-project",{meta:{cwd:path.join(root,"proj_002")}})
  const source=ctx.sessions.create("worker-a",{meta:{cwd,agentPreset:"explore"}})
  const event=message(source,"sharedmarker challenge A tool evidence")
  const toolCall=source.append("tool/call",{turn:1,step:1,callId:"fixture-tool",name:"fixture_probe",arguments:JSON.stringify({query:"toolmarker"})})
  const toolResult=source.append("tool/result",{turn:1,step:1,message:{id:randomUUID(),role:"tool",source:{kind:"tool",callId:"fixture-tool"},toolCallId:"fixture-tool",name:"fixture_probe",isError:false,content:[{type:"text",text:"toolmarker concrete stdout"}]}},{surfaceOp:"append",sourceEventSeqs:[toolCall.seq]})
  const secret=message(foreign,"sharedmarker foreign-only-private")
  for (const role of ["reason","explore","bootstrap"]) {
    const agent=await caller(ctx,cwd,role)
    for (const name of query.SESSION_QUERY_TOOLS) assert.ok(ctx.tools.get(name,agent),`${role}: ${name}`)
    if(role==="reason") for(const name of ["write","edit","bash","pwsh"]) assert.equal(ctx.tools.get(name,agent),undefined)
    const own=message(agent.session,"sharedmarker challenge B prior planning")
    agent.session.append("step/start",{turn:1,step:1})
    message(agent.session,"currentstepmarker must not be searched")
    const search=await call(ctx,agent,"session_search",{query:"sharedmarker"})
    assert.equal(search.isError,false,text(search)); assert.match(text(search),/worker-a/); assert.doesNotMatch(text(search),/foreign-project|foreign-only-private/)
    const filtered=await call(ctx,agent,"session_search",{query:"sharedmarker",session_ids:["foreign-project"]})
    assert.doesNotMatch(text(filtered),/foreign-project|foreign-only-private/)
    const events=await call(ctx,agent,"session_event_search",{session_id:source.id,query:"sharedmarker"})
    assert.equal(events.isError,false,text(events));assert.match(text(events),/sharedmarker/)
    for (const [name,args] of [["session_event_read",{session_id:source.id,seq:event.seq}], ["session_trace",{session_id:source.id}], ["session_event_trace",{session_id:source.id,seq:event.seq}]]) {
      const result=await call(ctx,agent,name,args); assert.equal(result.isError,false,text(result))
      const denied=await call(ctx,agent,name,{...args,session_id:foreign.id,...(args.seq===undefined?{}:{seq:secret.seq})});assert.equal(denied.isError,true,text(denied))
    }
    assert.equal((await call(ctx,agent,"session_event_search",{session_id:foreign.id,query:"sharedmarker"})).isError,true)
    const toolHits=await call(ctx,agent,"session_event_search",{session_id:source.id,query:"toolmarker",event_types:["tool/result"]})
    assert.equal(toolHits.isError,false,text(toolHits));assert.match(text(toolHits),/concrete stdout/)
    const exactTool=await call(ctx,agent,"session_event_read",{session_id:source.id,seq:toolResult.seq})
    assert.equal(exactTool.isError,false,text(exactTool));assert.match(text(exactTool),/concrete stdout/)
    const lineage=await call(ctx,agent,"session_event_trace",{session_id:source.id,seq:toolCall.seq})
    assert.equal(lineage.isError,false,text(lineage));assert.ok(text(lineage).includes(`Direct derived events: ${toolResult.seq}`))
    const ownRead=await call(ctx,agent,"session_event_read",{seq:own.seq}); assert.equal(ownRead.isError,false,text(ownRead))
    const current=await call(ctx,agent,"session_event_search",{query:"currentstepmarker"});assert.equal(current.isError,false,text(current));assert.doesNotMatch(text(current),/must not be searched/)
  }
  await ctx.sessions.flush(source)
  assert.equal((await manager.stop("redtrace-trace-search")).status,"stopped")
  assert.ok(JSON.parse(readFileSync(path.join(root,"plugins.json"),"utf8")).disabled.includes("redtrace-trace-search"))
  assert.equal(ctx.tools.get("session_search"),undefined,"disable removes native tools")
  assert.ok(existsSync(path.join(root,"session-query.sqlite")),"disable retains derived index")
  assert.equal((await manager.start("redtrace-trace-search")).status,"running")
  const agent=await caller(ctx,cwd,"reason")
  assert.match(text(await call(ctx,agent,"session_search",{query:"sharedmarker"})),/worker-a/)
})

test("JSONL history survives runtime restart, index rebuild, and resumed Session identity",async t=>{
  const root=mkdtempSync(path.join(tmpdir(),"redtrace-query-restart-")),cwd=path.join(root,"proj_001")
  mkdirSync(cwd);t.after(()=>rmSync(root,{recursive:true,force:true}))
  let ctx=await host(root)
  try {
    await ctx.plugin(query,{sessionRoot:root}).await()
    const source=ctx.sessions.create("durable-worker",{meta:{cwd,agentPreset:"explore"}})
    const event=message(source,"durablemarker historical tool outcome")
    const persisted = await ctx.sessionPersistence.create(source.header)
    await persisted.append([event])
    await persisted.flush(); await persisted.close()
    const agent=await caller(ctx,cwd,"reason")
    assert.match(text(await call(ctx,agent,"session_search",{query:"durablemarker"})),/durable-worker/)
    await ctx.fiber.dispose();ctx=await host(root)
    await ctx.plugin(query,{sessionRoot:root}).await()
    const resumed=await ctx.agents.resume({resumeSessionId:source.id,setup:async()=>{}})
    assert.equal(resumed.agent.session.id,source.id)
    assert.equal(resumed.agent.session.header.cwd,cwd)
    message(resumed.agent.session,"resumedmarker continued same session")
    await ctx.sessions.flush(resumed.agent.session)
    await resumed.dispose()
    const observer=await caller(ctx,cwd,"bootstrap")
    assert.match(text(await call(ctx,observer,"session_search",{query:"resumedmarker"})),/durable-worker/)
    assert.match(text(await call(ctx,observer,"session_event_read",{session_id:source.id,seq:event.seq})),/historical tool outcome/)
    await ctx.fiber.dispose()
    rmSync(path.join(root,"session-query.sqlite"))
    ctx=await host(root);await ctx.plugin(query,{sessionRoot:root}).await()
    const rebuilt=await caller(ctx,cwd,"explore")
    const search=await call(ctx,rebuilt,"session_search",{query:"durablemarker"})
    assert.equal(search.isError,false,text(search));assert.match(text(search),/durable-worker/)
  } finally { await ctx.fiber.dispose() }
})

test("large Session event reads stay inline for Reason and Spill only for Execute", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "redtrace-query-spill-")), ctx = await host(root)
  t.after(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(query, { sessionRoot: root }).await()
  const source = ctx.sessions.create("large-worker", { meta: { cwd: root } })
  const event = message(source, `HEAD\n${"history evidence line\n".repeat(20000)}TAIL`)
  await ctx.sessionQuery.readEvent({ sessionId: source.id, seq: event.seq })
  for (const role of ['reason', 'explore', 'bootstrap']) {
    const agent = await caller(ctx, root, role)
    const result = await call(ctx, agent, "session_event_read", { session_id: source.id, seq: event.seq })
    assert.equal(result.isError, false, text(result))
    if (role === 'reason') {
      assert.match(text(result), /HEAD/); assert.match(text(result), /TAIL/)
      assert.doesNotMatch(text(result), /Full formatted result stored at:/)
      assert.equal(agent.ctx.get('spillStore'), undefined)
      assert.equal(existsSync(path.join(root, 'spill')), false)
    } else {
      const file = text(result).match(/Full formatted result stored at: (.*?)\. Use read/s)?.[1]
      assert.ok(file, text(result)); assert.match(readFileSync(file, "utf8"), /TAIL/)
      const recovered = await call(ctx, agent, "read", { file_path: file, offset: 1, limit: 6 })
      assert.equal(recovered.isError, false, text(recovered))
    }
  }
})
