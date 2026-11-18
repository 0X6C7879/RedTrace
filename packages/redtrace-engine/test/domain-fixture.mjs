import {readFileSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {TOOL_DOMAINS,domainAction,originalTool} from '../../redtrace-dsh/lib/tool-domains.js'
/** Keep protocol scenarios readable while sending only actual domain/action calls on the wire. */
export function domainFixtureRequest(input,res) {
 recordWireRequest(input)
 const visible=new Set((input.tools??[]).map(t=>t.function.name))
 input.wireTools=structuredClone(input.tools??[])
 if([...visible].some(name=>TOOL_DOMAINS[name]))for(const name of visible)assert(!domainAction(name),'retired Schema exposed: '+name)
 input.tools=(input.tools??[]).flatMap(t=>TOOL_DOMAINS[t.function.name]?(t.function.parameters.properties.action.enum).map(action=>({...t,function:{...t.function,name:TOOL_DOMAINS[t.function.name][action]}})):[t])
 for(const m of input.messages??[])for(const c of m.tool_calls??[]){let args;try{args=JSON.parse(c.function.arguments)}catch{continue}const original=originalTool(c.function.name,args.action);if(original){c.function.name=original;delete args.action;c.function.arguments=JSON.stringify(args)}}
 const translate=value=>typeof value!=='string'?value:value.split('\n').map(line=>{if(!line.startsWith('data: {'))return line;const frame=JSON.parse(line.slice(6));for(const choice of frame.choices??[])for(const c of choice.delta?.tool_calls??[]){const mapped=domainAction(c.function?.name);if(!mapped||!visible.has(mapped.domain))continue;const args=JSON.parse(c.function.arguments||'{}');if(c.function.name==='legion_plan_done'&&args.through===undefined){const launch=[...(input.messages??[])].reverse().map(m=>{try{return JSON.parse(typeof m.content==='string'?m.content:(m.content??[]).map(b=>b.text??'').join(''))}catch{return null}}).find(m=>m?.plannerRound);args.through=launch?.plannerRound.triggers.cursor??0}c.function.name=mapped.domain;c.function.arguments=JSON.stringify({action:mapped.action,...args})}return'data: '+JSON.stringify(frame)}).join('\n')
 const end=res.end.bind(res),write=res.write.bind(res);res.end=(value,...args)=>end(translate(value),...args);res.write=(value,...args)=>write(translate(value),...args)
 return input
}

export function recordWireRequest(body){
 const file=process.env.REDTRACE_SCHEMA_METRICS;if(!file)return
 const text=m=>typeof m.content==='string'?m.content:(m.content??[]).map(b=>b.text??'').join('')
 const system=(body.messages??[]).filter(m=>m.role==='system').map(text).join('\n'),role=system.match(/你是 (COMMANDER|PLANNER|GENERAL|SOLDIER|SCOUT|WORKER)/)?.[1]?.toLowerCase()??'other'
 const schema=JSON.stringify(body.tools??[]),context=JSON.stringify(body.messages??[]);let rows=[];try{rows=JSON.parse(readFileSync(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
 const launches=(body.messages??[]).filter(m=>m.role==='user').map(m=>{try{return JSON.parse(text(m))}catch{return null}}).filter(m=>m?.plannerRound);const launch=launches.at(-1);
 rows.push({role,...(launch?{launchBytes:Buffer.byteLength(JSON.stringify(launch)),launchEstimatedTokens:Math.ceil(JSON.stringify(launch).length/4)}:{}),count:(body.tools??[]).length,schemaBytes:Buffer.byteLength(schema),schemaEstimatedTokens:Math.ceil(schema.length/4),contextBytes:Buffer.byteLength(context),contextEstimatedTokens:Math.ceil(context.length/4),tools:body.tools})
 writeFileSync(file,JSON.stringify(rows,null,2))
}
