/* Shared UI; native histories and FGS remain backend-owned. */
window.redtraceWorkbench = {
  conversationModels:null,modelSelections:{},reasoningSelections:{},modelError:'',
  async loadConversationModels(){try{this.conversationModels=await this.api('GET','/v2/chats/models');this.modelError='';for(const id of Object.keys(this.reasoningSelections)){const model=this.conversationModels.find(m=>m.name===this.modelSelections[id])||(!this.modelSelections[id]?this.conversationModels[0]:null);if(!model?.reasoningEfforts.includes(this.reasoningSelections[id])||this.reasoningSelections[id]==='off')this.reasoningSelections[id]=''}}catch(e){this.conversationModels=[];this.modelError=e.message}},
  syncComposerModel(target){const id=this.composerChatId(target);if(!id)return;const chat=target==='global'?this.chat:this.workbench?.input;if(!(id in this.modelSelections)){this.modelSelections[id]=(chat?.kind==='commander-input'?this.legion?.campaign?.nextWorker:chat?.selectedWorker)||'';const effort=(chat?.kind==='commander-input'?this.legion?.campaign?.reasoning:chat?.reasoning)||'';this.reasoningSelections[id]=effort==='off'||this.conversationModels!==null&&!this.reasoningOptions(target).includes(effort)?'':effort}},
  composerModel(target){return (this.conversationModels||[]).find(m=>m.name===this.modelSelections[this.composerChatId(target)])||(!this.modelSelections[this.composerChatId(target)]?this.conversationModels?.[0]:undefined)},
  reasoningOptions(target){return ['',...(this.composerModel(target)?.reasoningEfforts||[]).filter(e=>e!=='off')]},
  reasoningPosition(target){return Math.max(0,this.reasoningOptions(target).indexOf(this.reasoningSelections[this.composerChatId(target)]||''))},
  reasoningLabel(value){return ({'':'默认',off:'默认',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最高'})[value]||value},
  chooseReasoning(target,effort){const id=this.composerChatId(target);if(effort&&!this.modelSelections[id])this.modelSelections[id]=this.composerModel(target)?.name||'';this.reasoningSelections[id]=effort},
  changeComposerModel(target){this.reasoningSelections[this.composerChatId(target)]=''},
  resizeComposer(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,160)+'px'},
  submitComposer(event){if(event.shiftKey||event.isComposing||event.keyCode===229)return;event.preventDefault();const form=event.target.form;if(!form.querySelector('button[type=submit]').disabled)form.requestSubmit()},
  conversationRole(row){if(row.actor==='Commander')return 'commander';if(['参谋长','全局助手'].includes(row.actor))return 'chief';if(row.actor==='你')return 'user';const worker=this.workbench?.workers.find(w=>w.id===row.run_id||w.label===row.actor);return worker?.role||(['commander','general','soldier','scout'].includes(row.task_type)?row.task_type:'system')},


  graphLogEvents:[],graphLogHasMore:false,graphLogError:'',
  async loadGraphLog(older=false){const project=this.selectedProjectId,graph=this.selectedGraphId;try{const before=older?Math.min(...this.graphLogEvents.map(e=>e.id)):Number.MAX_SAFE_INTEGER;const page=await this.api('GET','/audit/tasks/'+encodeURIComponent(project)+'/events?graphId='+encodeURIComponent(graph)+'&limit=100&before_id='+before);if(project!==this.selectedProjectId||graph!==this.selectedGraphId)return;this.graphLogEvents=older?[...page,...this.graphLogEvents]:page;this.graphLogHasMore=page.length===100;this.graphLogError=''}catch(e){this.graphLogError=e.message}},
  graphLogRows(){return this.graphLogEvents.map(e=>({...e,actor:this.graphWorkerRuns.find(w=>w.id===e.run_id)?.label||e.worker||e.task_type}))},
  chiefEvents:[],chiefOffset:0,chiefHasMore:false,
  uploadsByChat:{},pendingUploads:{},uploadingIds:{},inputErrors:{},
  composerChatId(target){return target==='global'?this.chatId:this.workbench?.input?.id||''},
  pendingFiles(target){return this.pendingUploads[this.composerChatId(target)]||[]},
  async loadUploads(id){if(id&&!this.uploadsByChat[id])this.uploadsByChat[id]=await this.api('GET','/v2/chats/'+encodeURIComponent(id)+'/attachments')},
  async pasteImages(event,target){const files=[...event.clipboardData.files].filter(file=>file.type.startsWith('image/'));if(!files.length)return;event.preventDefault();await this.uploadFiles({target:{files,value:''}},target)},
  async uploadFiles(event,target){const id=this.composerChatId(target),files=[...event.target.files];if(!id||!files.length)return;this.inputErrors[id]='';this.uploadingIds[id]=true;try{await this.loadUploads(id);for(const file of files){const response=await fetch('/v2/chats/'+encodeURIComponent(id)+'/attachments',{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-Filename':encodeURIComponent(file.name)},body:file});const value=await response.json();if(!response.ok)throw new Error(value.detail||value.error||value.message||'上传失败');this.uploadsByChat[id].push(value);(this.pendingUploads[id]??=[]).push(value)}}catch(e){this.inputErrors[id]=e.message}finally{delete this.uploadingIds[id];event.target.value=''}},
  removeUpload(target,id){const chat=this.composerChatId(target);this.pendingUploads[chat]=(this.pendingUploads[chat]||[]).filter(u=>u.id!==id)},
  uploadUrl(block,target='workbench'){const u=(this.uploadsByChat[this.composerChatId(target)]||[]).find(u=>u.attachment.attachmentId===block.attachment?.attachmentId&&u.attachment.name===block.attachment.name);return u?'/v2/chats/'+encodeURIComponent(u.chatId)+'/attachments/'+encodeURIComponent(u.id):''},
  sendingWorkbench(){return !!this.chatSendingIds[this.composerChatId('workbench')]},
  canComposeWorkbench(){return this.conversationId==='chief'||this.conversationId==='commander'&&this.workbench?.project.mode==='benchmark'},
  conversationPlanningTodos:[],
  conversationTodos(){
    if(this.workbench?.project.mode==='general')return this.conversationId==='commander'?this.workbench.todos:null;
    return this.workbench?.conversations.some(c=>c.id===this.conversationId&&c.graphId)?this.conversationPlanningTodos:null;
  },
  workbench:null,conversationId:'commander',conversationEvents:[],conversationMessages:[],conversationGraphEvents:[],conversationCursor:0,conversationBefore:null,conversationHasMore:false,conversationEventCursor:0,
  commanderLogSession:'',
  commanderSessions(){return [...new Set([...(this.legion?.campaign?.sessionHistory||[]),this.legion?.campaign?.previousSessionId,this.legion?.campaign?.sessionId].filter(Boolean))]},
  async selectCommanderHistory(){this.commanderHistory=[];this.commanderOffset=0;this.commanderSession='';await this.loadConversation();},
  commanderOffset:0,commanderHistory:[],commanderSession:'',commanderHasMore:false,conversationLoading:false,conversationError:'',conversationQuery:'',workbenchCommand:'',workbenchSending:false,
  chats:[],chatId:'',chat:null,chatQuery:'',chatDraft:'',chatEvents:[],chatOffset:0,chatHasMore:false,chatLoading:false,chatSendingIds:{},chatError:'',newChatTitle:'',
  workbenchConversations(){return (this.workbench?.conversations||[]).filter(c=>!this.conversationQuery||c.title.toLowerCase().includes(this.conversationQuery.toLowerCase())).sort((a,b)=>Number(b.running)-Number(a.running)||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));},
  async selectConversation(id){this.conversationId=id;this.conversationPlanningTodos=[];this.conversationEvents=[];this.conversationMessages=[];this.conversationGraphEvents=[];this.conversationCursor=0;this.conversationBefore=null;this.conversationEventCursor=0;this.conversationHasMore=false;this.conversationError='';localStorage.setItem('redtrace-conversation-'+this.legionProjectId,id);await this.loadConversation();},
  conversationTitle(){return this.conversationId==='chief'?'会话':this.conversationId==='commander'?'Commander':this.workbench?.conversations.find(c=>c.id===this.conversationId)?.title||'Worker';},
  conversationUrl(){const c=this.workbench?.conversations.find(c=>c.id===this.conversationId);if(!c)return '';return '/v2/projects/'+encodeURIComponent(this.legionProjectId)+'/conversation?'+(c.runId?'runId='+encodeURIComponent(c.runId):'graphId='+encodeURIComponent(c.graphId));},
  async loadConversation(older=false){
    this.syncComposerModel('workbench');if(this.conversationModels===null)void this.loadConversationModels();
    if(this.conversationLoading)return;const projectId=this.legionProjectId,id=this.conversationId;this.conversationLoading=true;
    try{
      if(this.workbench?.input?.id)await this.loadUploads(this.workbench.input.id);
      if(projectId!==this.legionProjectId||id!==this.conversationId)return;
      if(id==='chief'){
        const chat=this.workbench?.chief;if(!chat)return;
        const page=await this.api('GET','/v2/chats/'+chat.id+'/events?offset='+this.chiefOffset+'&limit=100');
        if(projectId!==this.legionProjectId||id!==this.conversationId)return;
        this.chiefEvents.push(...page.events);this.chiefOffset=page.nextOffset;this.chiefHasMore=page.hasMore;
      }else if(id==='commander'){
        const page=await this.api('GET','/v2/legion/session/events?projectId='+encodeURIComponent(projectId)+'&offset='+this.commanderOffset+'&limit=100'+(this.commanderLogSession?'&sessionId='+encodeURIComponent(this.commanderLogSession):''));
        if(projectId!==this.legionProjectId||id!==this.conversationId)return;
        if(this.commanderSession&&this.commanderSession!==page.sessionId){this.commanderOffset=0;this.commanderSession=page.sessionId;return;}
        this.commanderHistory.push(...page.events);this.commanderSession=page.sessionId;this.commanderOffset=page.nextOffset;this.commanderHasMore=page.hasMore;
      }else{
        const url=this.conversationUrl();if(!url)return;const initial=!this.conversationCursor;
        const page=await this.api('GET',url+(older?'&before='+this.conversationBefore:initial?'&before='+Number.MAX_SAFE_INTEGER:'&after='+this.conversationCursor)+'&eventAfter='+this.conversationEventCursor);
        if(projectId!==this.legionProjectId||id!==this.conversationId)return;
        this.conversationEvents=[...new Map([...this.conversationEvents,...page.events].map(e=>[e.event_uid||e.id,e])).values()];
        if(!older)this.conversationCursor=Math.max(this.conversationCursor,page.cursor);
        if(initial||older){this.conversationBefore=page.before;this.conversationHasMore=page.hasMore;}
        this.conversationPlanningTodos=page.todos||[];
        this.conversationMessages=page.messages;this.conversationGraphEvents=[...new Map([...this.conversationGraphEvents,...page.graphEvents].map(e=>[e.id,e])).values()];this.conversationEventCursor=page.eventCursor;
      }this.conversationError='';
    }catch(e){if(projectId===this.legionProjectId&&id===this.conversationId)this.conversationError=e.message;}finally{this.conversationLoading=false;}
  },
  workerLabel(runId){return this.workbench?.workers.find(w=>w.id===runId)?.label||runId||'Worker';},
  messageText(content){try{const m=JSON.parse(content);return m.content??content}catch{return content}},
  conversationGraphId(){return this.workbench?.conversations?.find(c=>c.id===this.conversationId)?.graphId||''},
  conversationWorkers(){const c=this.workbench?.conversations?.find(c=>c.id===this.conversationId);return (this.workbench?.workers||[]).filter(w=>c&&(c.runId?w.id===c.runId:w.graphId===c.graphId))},
  globalChatRows(){return this.chatEvents.map(e=>({...e,key:e.event_uid,actor:e.kind==='user.message'?'你':'全局助手',task_type:'commander',attachmentTarget:'global'}))},
  conversationRows(){
    if(this.conversationId==='chief')return this.chiefEvents.map(e=>({...e,key:e.event_uid,actor:e.kind==='user.message'?'你':'助手',task_type:'commander'}));
    if(this.conversationId==='commander')return [...this.commanderHistory.map(e=>({...e,key:e.event_uid,kind:e.kind==='user.message'?'session.context':e.kind,actor:'Commander',task_type:'commander'})),...(this.legion?.messages||[]).filter(m=>m.receiver==='commander'&&!this.workbench?.workers.some(w=>w.id===m.sender)).map(m=>({key:m.id,kind:'user.message',content:this.messageText(m.content),attachments:m.attachments,timestamp:m.createdAt,actor:m.sender==='global-assistant'?'全局助手':m.sender==='chief'?'助手':'你',task_type:'commander',status:m.status}))].sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp)));
    return [...this.conversationEvents.map(e=>({...e,kind:e.kind==='user.message'?'session.context':e.kind,key:'audit-'+(e.event_uid||e.id),actor:this.workerLabel(e.run_id),task_type:this.conversationRole(e)})),
      ...this.conversationMessages.map(m=>({key:m.id,kind:m.type==='MESSAGE'?'user.message':'assistant.message',content:this.messageText(m.content),timestamp:m.createdAt,actor:m.sender==='commander'?'Commander':this.workerLabel(m.sender),task_type:m.sender==='commander'?'commander':this.conversationRole({run_id:m.sender}),status:m.status}))].sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp))||String(a.key).localeCompare(String(b.key)));
  },
  async sendWorkbenchCommand(){const id=this.workbench?.input?.id,files=this.pendingFiles('workbench');if(!this.canComposeWorkbench()||!this.workbenchCommand.trim()&&!files.length||this.chatSendingIds[id]||this.uploadingIds[id])return;this.inputErrors[id]='';this.chatSendingIds[id]=true;const project=this.legionProjectId;try{const payload={content:this.workbenchCommand,worker:this.modelSelections[id]||null,reasoning:this.reasoningSelections[id]||null,attachmentIds:files.map(u=>u.id)};if(this.conversationId==='chief')await this.api('POST','/v2/chats/'+id+'/messages',payload);else await this.api('POST','/v2/legion/message',{...payload,projectId:project,receiver:'commander',type:'MESSAGE'});this.pendingUploads[id]=[];if(project===this.legionProjectId){this.workbenchCommand='';await this.loadLegion()}}catch(e){this.inputErrors[id]=e.message}finally{delete this.chatSendingIds[id]}},
  currentStage(){return this.workbench?.todos.find(t=>t.status==='in_progress')?.content||this.workbench?.todos.find(t=>t.status==='pending')?.content||'等待规划';},
  runningSteps(){return (this.workbench?.steps||[]).filter(s=>s.status==='running');},
  async loadChats(){if(this.conversationModels===null)void this.loadConversationModels();try{this.chats=await this.api('GET','/v2/chats?query='+encodeURIComponent(this.chatQuery));if(!this.chatId){const saved=localStorage.getItem('redtrace-global-chat');if(this.chats.some(c=>c.id===saved))await this.selectChat(saved);}if(this.chatId)await this.loadChat();}catch(e){this.chatError=e.message}},
  async createChat(){try{const chat=await this.api('POST','/v2/chats',{title:this.newChatTitle.trim()||'新对话'});this.newChatTitle='';this.chats.unshift(chat);await this.selectChat(chat.id);}catch(e){this.chatError=e.message}},
  async selectChat(id){this.chatDraft='';this.chatId=id;this.chat=this.chats.find(c=>c.id===id)||null;this.chatEvents=[];this.chatOffset=0;this.chatHasMore=false;localStorage.setItem('redtrace-global-chat',id);await this.loadChat();},
  async loadChat(){if(!this.chatId||this.chatLoading)return;const id=this.chatId;this.chatLoading=true;try{const [chat,page]=await Promise.all([this.api('GET','/v2/chats/'+id),this.api('GET','/v2/chats/'+id+'/events?offset='+this.chatOffset+'&limit=100')]);if(id!==this.chatId)return;this.chat=chat;this.syncComposerModel('global');await this.loadUploads(id);if(id!==this.chatId)return;this.chatEvents.push(...page.events);this.chatOffset=page.nextOffset;this.chatHasMore=page.hasMore;this.chatError=chat.error||'';}catch(e){if(id===this.chatId)this.chatError=e.message}finally{this.chatLoading=false}},
  async sendChat(){if(!this.chatDraft.trim()&&!this.pendingFiles('global').length||this.chatSendingIds[this.chatId]||this.uploadingIds[this.chatId])return;const id=this.chatId,text=this.chatDraft;this.inputErrors[id]='';this.chatSendingIds[id]=true;try{await this.api('POST','/v2/chats/'+id+'/messages',{content:text,worker:this.modelSelections[id]||null,reasoning:this.reasoningSelections[id]||null,attachmentIds:(this.pendingUploads[id]||[]).map(u=>u.id)});this.pendingUploads[id]=[];if(id===this.chatId){this.chatDraft='';await this.loadChat();}}catch(e){this.inputErrors[id]=e.message}finally{delete this.chatSendingIds[id]}},
};
