import { type ProjectMode, coordinatorRole } from '../../redtrace-dsh/src/roles.ts'
import { randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import type { Store } from './store.ts'
import type { EngineConfig } from './types.ts'
import { CommanderTodos } from './legion-todos.ts'
import type { Router } from './http.ts'
import { body, queryNumber } from './http.ts'
import { HttpError, requiredText, now } from './types.ts'
import type { AgentTool } from './tool-types.ts'
import { Check } from 'typebox/value'
import { modelReasoningEfforts } from './models.ts'

export interface Upload { id:string;chatId:string;type:'image'|'file';attachment:Record<string,any>;createdAt:string }
export interface ConversationModel { name:string;worker:string;provider:string;model:string;reasoningEfforts:string[] }
export function conversationWorkers(config:EngineConfig, mode?:ProjectMode) {return config.workers.filter(w=>w.enabled&&w.backend==='dsh'&&(mode ? w.roles?.includes(coordinatorRole(mode)) : w.roles?.some(r=>r==='commander'||r==='general'))).sort((a,b)=>a.priority-b.priority||a.name.localeCompare(b.name))}
export function configuredConversationModels(config:EngineConfig, mode?:ProjectMode):ConversationModel[] {
  const workers=conversationWorkers(config,mode), routes=workers.map(w=>({name:w.name,worker:w.name,provider:w.provider,model:w.model}))
  if(workers.length)for(const [provider,profile] of Object.entries(config.providers))for(const model of profile.models) {
    if(!routes.some(r=>r.provider===provider&&r.model===model.id))routes.push({name:JSON.stringify([workers[0].name,provider,model.id]),worker:workers[0].name,provider,model:model.id})
  }
  return routes.map(route=>{const model=config.providers[route.provider]?.models.find(m=>m.id===route.model),efforts=model&&modelReasoningEfforts(model);return {...route,reasoningEfforts:efforts?Object.keys(efforts).filter(k=>k!=='off'&&efforts[k]!==null):[]}})
}
/** Model choice changes the native model, never the Worker's role, capacity or tool bindings. */
export function conversationWorker(config:EngineConfig,selection:string,mode?:ProjectMode) {
  const route=configuredConversationModels(config,mode).find(r=>r.name===selection),worker=conversationWorkers(config,mode).find(w=>w.name===route?.worker)
  return worker&&route?{...worker,provider:route.provider,model:route.model}:undefined
}
export interface Chat { selectedWorker?:string; reasoning?:string; projectId?:string; kind?:'chief'|'commander-input'; id:string; title:string; sessionId:string; createdAt:string; updatedAt:string; status:'idle'|'running'|'failed'; hasSession:boolean; workerName?:string; error?:string }
/** Conversation bodies live only in native DSH persistence; this table is an index. */
export class ChatStore {
  private readonly deleting=new Set<string>()
  readonly store:Store
  removeSession?: (chat:Chat)=>Promise<void>
  stopProject?: (projectId:string)=>Promise<void>
  runtime?: (chat:Chat,content:string,uploads?:Upload[],worker?:string|null,reasoning?:string|null,emit?:(event:Record<string,unknown>)=>void)=>Promise<unknown>
  models?:(mode?:ProjectMode)=>Promise<ConversationModel[]>
  upload?: (chat:Chat,req:import('node:http').IncomingMessage)=>Promise<Upload>
  readUpload?: (upload:Upload,offset?:number,length?:number)=>Promise<unknown>
  download?: (upload:Upload,context:import('./http.ts').RequestContext)=>Promise<void>
  events?: (chat:Chat,offset:number,limit:number,signal:AbortSignal)=>Promise<unknown>
  constructor(store:Store) {
    this.store=store
    store.db.exec('CREATE TABLE IF NOT EXISTS chat_uploads(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES global_chats(id) ON DELETE CASCADE,data TEXT NOT NULL)')

  }
  list(query=''):Chat[] { return this.store.db.prepare("SELECT data FROM global_chats WHERE project_id IS NULL AND instr(lower(json_extract(data,'$.title')),lower(?))>0 ORDER BY json_extract(data,'$.updatedAt') DESC").all(query).map(r=>JSON.parse(String(r.data))) }
  all():Chat[] {return this.store.db.prepare('SELECT data FROM global_chats').all().map(r=>JSON.parse(String(r.data)))}
  chief(projectId:string):Chat {const project=this.store.project(projectId);if(project.mode!=='general')throw new HttpError(422,'Chief is the General user entry only');const id='chief-'+projectId,row=this.store.db.prepare('SELECT data FROM global_chats WHERE id=?').get(id);return row?JSON.parse(String(row.data)):this.save({id,projectId,kind:'chief',title:'参谋长 · '+project.title,sessionId:id,createdAt:now(),updatedAt:now(),status:'idle',hasSession:false})}
  entry(projectId:string):Chat {const project=this.store.project(projectId);if(project.mode==='general')return this.chief(projectId);const id='input-'+projectId,row=this.store.db.prepare('SELECT data FROM global_chats WHERE id=?').get(id);return row?JSON.parse(String(row.data)):this.save({id,projectId,kind:'commander-input',title:'Commander 输入附件',sessionId:id,createdAt:now(),updatedAt:now(),status:'idle',hasSession:false})}
  uploads(chatId:string):Upload[] {this.get(chatId);return this.store.db.prepare('SELECT data FROM chat_uploads WHERE chat_id=? ORDER BY rowid').all(chatId).map(r=>JSON.parse(String(r.data)))}
  owned(chatId:string,ids:string[]):Upload[] {const uploads=this.uploads(chatId);return ids.map(id=>{const upload=uploads.find(u=>u.id===id);if(!upload)throw new HttpError(404,'Attachment does not belong to this conversation');return upload})}
  saveUpload(upload:Upload) {this.get(upload.chatId);this.store.db.prepare('INSERT INTO chat_uploads VALUES (?,?,?)').run(upload.id,upload.chatId,JSON.stringify(upload));return upload}
  get(id:string):Chat { if(this.deleting.has(id))throw new HttpError(409,'Conversation deletion is in progress');const row=this.store.db.prepare('SELECT data FROM global_chats WHERE id=?').get(id);if(!row)throw new HttpError(404,'Conversation not found');return JSON.parse(String(row.data)) }
  save(chat:Chat) { this.store.db.prepare('INSERT INTO global_chats(id,data,project_id) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(chat.id,JSON.stringify(chat),chat.projectId??null);return chat }
  async remove(id:string) {const chat=this.get(id);if(chat.projectId)throw new HttpError(422,'Project conversations are deleted with their Project');if(chat.status==='running')throw new HttpError(409,'Wait for the response before deleting this conversation');if(!this.removeSession)throw new HttpError(503,'Native conversation cleanup requires the DSH host');this.deleting.add(id);try{await this.removeSession(chat);this.store.db.prepare('DELETE FROM global_chats WHERE id=?').run(id);return {deleted:true,id}}finally{this.deleting.delete(id)}}
  create(title:string) {const id='chat-'+randomUUID();return this.save({id,title:requiredText(title,'title'),sessionId:id,createdAt:now(),updatedAt:now(),status:'idle',hasSession:false})}
}
export function chatSlots(store:Store): {projectId:string;workerName?:string}[] { return store.db.prepare("SELECT data FROM global_chats WHERE json_extract(data,'$.status')='running'").all().map(r=>{const c=JSON.parse(String(r.data));return{projectId:c.projectId??'',workerName:c.workerName}}) }
export function chatRoutes(router:Router,chats:ChatStore,configuration:()=>EngineConfig) {
  const text=Type.String({minLength:1})
  router.add('GET','/v2/projects/:project/chief',c=>chats.chief(c.params.project))
  router.add('POST','/v2/chats/:chat/attachments',c=>{const chat=chats.get(c.params.chat);if(!chats.upload)throw new HttpError(503,'Attachments require the DSH host');return chats.upload(chat,c.req)})
  router.add('GET','/v2/chats/:chat/attachments',c=>chats.uploads(c.params.chat))
  router.add('GET','/v2/chats/:chat/attachments/:upload',c=>{const upload=chats.owned(c.params.chat,[c.params.upload])[0];if(!chats.download)throw new HttpError(503,'DSH attachment reader unavailable');return chats.download(upload,c)})
  router.add('GET','/v2/chats/models',c=>{const mode=c.url.searchParams.get('mode')??undefined;if(mode!==undefined&&mode!=='general'&&mode!=='benchmark')throw new HttpError(422,'Invalid Project mode');return chats.models?chats.models(mode):configuredConversationModels(configuration(),mode)})
  router.add('GET','/v2/chats',c=>chats.list(c.url.searchParams.get('query')??''))
  router.add('POST','/v2/chats',async c=>chats.create((await body(c.req,Type.Object({title:text},{additionalProperties:false}))).title))
  router.add('DELETE','/v2/chats/:chat',c=>chats.remove(c.params.chat))
  router.add('GET','/v2/chats/:chat',c=>chats.get(c.params.chat))
  router.add('POST','/v2/chats/:chat/messages',async c=>{
    const input=await body(c.req,Type.Object({content:Type.String(),worker:Type.Optional(Type.Union([text,Type.Null()])),reasoning:Type.Optional(Type.Union([text,Type.Null()])),attachmentIds:Type.Optional(Type.Array(text,{uniqueItems:true}))},{additionalProperties:false})),content=input.content,chat=chats.get(c.params.chat),uploads=chats.owned(chat.id,input.attachmentIds??[])
    if(chat.kind==='commander-input')throw new HttpError(422,'Use the existing Commander mailbox for this Project')
    if(!content.trim()&&!uploads.length)throw new HttpError(422,'Message or attachment required')
    if(!chats.runtime)throw new HttpError(503,'Global conversations require the DSH host')
    if(chat.status==='running')throw new HttpError(409,'This conversation is already responding')
    // The DSH host owns activation, native write ownership, capacity and error persistence.
    if(!String(c.req.headers.accept??'').includes('application/x-ndjson'))return chats.runtime(chat,content,uploads,input.worker,input.reasoning)
    const emit=(event:Record<string,unknown>)=>{if(c.res.destroyed)return;if(!c.res.headersSent)c.res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});c.res.write(JSON.stringify(event)+'\n')}
    try{const result=await chats.runtime(chat,content,uploads,input.worker,input.reasoning,emit);emit({kind:'chat.completed',chat:result})}
    catch(error){if(!c.res.headersSent)throw error;emit({kind:'chat.error',error:error instanceof Error?error.message:String(error)})}
    c.res.end()
  })
  router.add('GET','/v2/chats/:chat/events',c=>{
    const chat=chats.get(c.params.chat)
    if(!chats.events) {if(chat.hasSession)throw new HttpError(503,'DSH history reader unavailable');return {events:[],nextOffset:0,hasMore:false,available:false,sessionId:chat.sessionId}}
    return chats.events(chat,queryNumber(c.url,'offset',0),queryNumber(c.url,'limit',100,1,500),c.signal)
  })
}

/** Cross-project queries are bounded and on demand. Mutations only use existing Hint/mailbox entry points. */
export function chatTools(store:Store,chat?:Chat,chats?:ChatStore):AgentTool[] {
  const text=Type.String({minLength:1}),limit=Type.Optional(Type.Integer({minimum:1,maximum:100})),offset=Type.Optional(Type.Integer({minimum:0}))
  const tool=(name:string,description:string,parameters:any,execute:(args:any)=>unknown):AgentTool=>({name,label:name,description,parameters,executionMode:'sequential',async execute(_id,args){if(!Check(parameters,args))throw new HttpError(422,'Invalid tool arguments');const value=await execute(args);return {content:[{type:'text',text:JSON.stringify(value)}],details:value}}})
  const attachments=Type.Optional(Type.Array(text,{uniqueItems:true}))
  const blocks=(ids:string[]=[])=>(chats?.owned(chat!.id,ids)??[]).map(u=>({type:u.type,attachment:u.attachment}))
  return [
    ...(chats&&chat?[tool('attachment_read','Read a user-uploaded file from this conversation only. Bounded UTF-8 or base64 bytes; images are native image blocks.',Type.Object({id:text,offset,length:Type.Optional(Type.Integer({minimum:1,maximum:7600}))},{additionalProperties:false}),args=>chats.readUpload!(chats.owned(chat.id,[args.id])[0],args.offset,args.length))]:[]),
    tool('projects','Search Project titles and current status. No graph or log bodies.',Type.Object({query:Type.Optional(Type.String()),offset,limit},{additionalProperties:false}),args=>store.projects().filter(p=>!args.query||p.title.toLowerCase().includes(args.query.toLowerCase())).slice(args.offset??0,(args.offset??0)+(args.limit??50)).map(p=>({id:p.id,title:p.title,mode:p.mode,status:p.status,objective:p.objective}))),
    tool('project_query','Read Graph indexes, Worker runs, Finding summaries, nodes, progress or the real planner-maintained phase plan for a specified Project only. Paginate; inspect node detail only when needed.',Type.Object({projectId:text,graphId:Type.Optional(text),kind:Type.Union(['graphs','workers','findings','nodes','progress','plan'].map(v=>Type.Literal(v))),nodeId:Type.Optional(text),offset,limit},{additionalProperties:false}),args=>{
      const view=args.graphId?store.forGraph(args.projectId,args.graphId):store.forProject(args.projectId),start=args.offset??0,end=start+(args.limit??50)
      if(args.kind==='plan'){const project=view.project(args.projectId);if(project.mode==='general')throw new HttpError(403,'General task TodoList is read and maintained only by Planner');if(!args.graphId&&project.mode==='benchmark')throw new HttpError(422,'Select a task Graph for its phase plan');const graphId=args.graphId??view.projectGraphs(args.projectId)[0].id;return {graphId,owner:'task planner',todos:new CommanderTodos(view,args.projectId).list(graphId)}}
      if(args.nodeId)return view.readNode(args.projectId,args.nodeId,'summary')
      if(args.kind==='graphs')return view.projectGraphs(args.projectId).slice(start,end)
      if(args.kind==='workers')return view.runs(args.projectId).slice(start,end).map(r=>({id:r.id,graphId:r.graphId,stepId:r.stepId,worker:r.worker,status:r.status,error:r.error,predecessorRunId:r.predecessorRunId}))
      if(args.kind==='progress')return {project:view.project(args.projectId),goals:view.nodes(args.projectId,['goal'],{offset:start,limit:args.limit??50,context:true}),steps:view.nodes(args.projectId,['step'],{offset:start,limit:args.limit??50,context:true})}
      return view.nodes(args.projectId,args.kind==='findings'?['finding']:['fact','goal','step','finding','hint'],{offset:start,limit:args.limit??50,context:true})
    }),
    tool('project_hint','Add an unverified Hint to the explicitly specified Project/Graph and forward it through its Commander mailbox. Does not take control of FGS or Workers.',Type.Object({projectId:text,graphId:text,content:text,attachmentIds:attachments},{additionalProperties:false}),args=>store.commanderInput(args.projectId,args.content,chat?.projectId?'chief':'global-assistant',args.graphId,blocks(args.attachmentIds))),
    tool('commander_message','Forward a human scheduling instruction to the selected Project Commander. Delivery is not action; do not claim it ran.',Type.Object({projectId:text,content:text,attachmentIds:attachments},{additionalProperties:false}),args=>store.commanderInput(args.projectId,args.content,chat?.projectId?'chief':'global-assistant',undefined,blocks(args.attachmentIds))),
  ]
}
