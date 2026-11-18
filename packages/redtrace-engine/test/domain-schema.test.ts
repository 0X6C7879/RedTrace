import test from 'node:test'
import assert from 'node:assert/strict'
import {Type} from 'typebox'
import {Check} from 'typebox/value'
import {domainTools} from '../../redtrace-dsh/src/tool-domains.ts'

test('domain action schemas and dispatch agree on action-specific fields, including optional-only actions',async()=>{
 const calls:unknown[]=[]
 const def=(name:string,properties:Record<string,any>)=>({name,description:name,parameters:Type.Object(properties,{additionalProperties:false}),execute:async(...args:unknown[])=>{calls.push(args);return args}})
 const tools=domainTools([
  def('legion_inbox',{}),def('legion_wait',{through:Type.Integer({minimum:0})}),
  def('legion_goal',{description:Type.String(),id:Type.Optional(Type.String())}),
  def('legion_accept',{expectedVersion:Type.Integer(),evidenceIds:Type.Array(Type.String())}),
  def('resource_list',{kind:Type.Optional(Type.String())}),def('resource_get',{id:Type.Optional(Type.String())})
 ])
 const valid:[string,Record<string,unknown>][]=[['legion_messages',{action:'read'}],['legion_messages',{action:'wait',through:1}],['legion_plan',{action:'goal',description:'fixture',id:'g1'}],['legion_plan',{action:'accept',expectedVersion:1,evidenceIds:['f1']}],['resource_manage',{action:'list',kind:'file'}],['resource_manage',{action:'get',id:'r1'}]]
 for(const [name,input]of valid){const tool=tools.find(t=>t.name===name)!;assert(Check(tool.parameters,input),JSON.stringify(input));await tool.execute(input)}
 const invalid:[string,Record<string,unknown>][]=[['legion_messages',{action:'read',through:1}],['legion_messages',{action:'wait'}],['legion_plan',{action:'accept',expectedVersion:1,evidenceIds:['f1'],id:'g1'}],['resource_manage',{action:'list',id:'r1'}],['resource_manage',{action:'get',kind:'file'}]]
 for(const [name,input]of invalid){const tool=tools.find(t=>t.name===name)!;assert(!Check(tool.parameters,input),JSON.stringify(input));await assert.rejects(async()=>tool.execute(input))}
 assert.equal(calls.length,valid.length,'invalid calls never reach original action')
 const tool=tools.find(t=>t.name==='legion_messages')!;const execution={fixture:true};await tool.execute('call-id',{action:'wait',through:3},execution);assert.deepEqual(calls.at(-1),['call-id',{through:3},execution])
})

test('domain branches retain shared-field type conflicts and common required fields',()=>{
 const def=(name:string,properties:Record<string,any>)=>({name,description:name,parameters:Type.Object(properties,{additionalProperties:false}),execute:()=>{}})
 const [tool]=domainTools([def('resource_list',{kind:Type.String(),value:Type.Optional(Type.String())}),def('resource_register',{kind:Type.Integer(),value:Type.Optional(Type.Integer())})])
 for(const input of [{action:'list',kind:'file',value:'x'},{action:'register',kind:1,value:2}])assert(Check(tool.parameters,input))
 for(const input of [{action:'list'},{action:'list',kind:1},{action:'list',kind:'file',value:2},{action:'register',kind:1,value:'x'},{action:'missing',kind:1}])assert(!Check(tool.parameters,input))
})
