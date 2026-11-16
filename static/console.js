// Management views share the existing engine APIs; no management-side state store.
window.systemLogsPage = function () {
  return {
    active:false,entries:[],query:'',level:'',autoFollow:true,loading:false,error:'',timer:0,updatedAt:'',
    get filtered(){const q=this.query.trim().toLowerCase();return this.entries.filter(e=>(!this.level||e.level===this.level)&&(!q||(e.source+' '+e.message).toLowerCase().includes(q)))},
    async setActive(active){if(this.active===active)return;this.active=active;clearInterval(this.timer);if(active){await this.load();if(this.active)this.timer=setInterval(()=>{if(this.autoFollow)void this.load()},2000)}},
    destroy(){clearInterval(this.timer)},
    async load(){if(this.loading)return;this.loading=true;try{const el=this.$refs?.logList,atEnd=!el||el.scrollHeight-el.scrollTop-el.clientHeight<48;this.entries=await capabilityRequest('GET','/console/logs');this.error='';this.updatedAt=new Date().toLocaleTimeString();if(this.autoFollow&&atEnd&&el)this.$nextTick(()=>{el.scrollTop=el.scrollHeight})}catch(e){this.error=e.message}finally{this.loading=false}},
  };
};
window.findingsPage = function () {
  return {
    scopeProject:'',scopeGraph:'',init(){if(this.$el.hasAttribute('data-findings-view'))mountConsoleTemplate(this.$el,'findings-content')},
    async setScope(project,graph,active){if(project!==this.scopeProject||graph!==this.scopeGraph){this.scopeProject=project;this.scopeGraph=graph;this.active=false;this.items=[];this.grouped=!project;this.task='';this.detail=null;this.selected=null;this.error=''}await this.setActive(active)},
    items: [], query: '', severity: '', task: '', type: '', status: '', grouped: true, expanded: {}, detail: null, selected: null, content: '', evidence: null, error: '', loading: false, active: false,
    severityLabel(value) { return ({critical:'严重',high:'高危',medium:'中危',low:'低危'})[value] || '未评级'; },
    statusLabel(value) { return ({active:'进行中',stopped:'已停止',completed:'已完成'})[value] || value; },
    get stats() { return ['critical','high','medium','low'].map(key => ({key,label:this.severityLabel(key),count:this.items.filter(f=>f.severity===key).length})); },
    get tasks() { return [...new Map(this.items.map(f=>[f.projectId,{id:f.projectId,title:f.projectTitle}])).values()]; },
    get types() { return [...new Set(this.items.map(f=>f.type))].sort(); },
    get roles(){return [...new Set(this.data.tools.flatMap(t=>t.roles||[]))].sort()},
    get filtered() { const q=this.query.trim().toLowerCase();return this.items.filter(f=>(!this.severity||f.severity===this.severity)&&(!this.task||f.projectId===this.task)&&(!this.type||f.type===this.type)&&(!this.status||f.projectStatus===this.status)&&(!q||[f.title,f.description,f.type,...(f.assetIds||[])].join(' ').toLowerCase().includes(q))); },
    get groups() { const groups=new Map();for(const f of this.filtered){if(!groups.has(f.projectId))groups.set(f.projectId,{id:f.projectId,title:f.projectTitle,status:f.projectStatus,items:[]});groups.get(f.projectId).items.push(f)}return [...groups.values()]; },
    async setActive(active) { if(active===this.active)return;this.active=active;if(active)await this.load(); },
    async load() { this.loading=true;this.error='';try{const project=this.scopeProject,graph=this.scopeGraph;const items=await capabilityRequest('GET','/console/findings?projectId='+encodeURIComponent(project)+'&graphId='+encodeURIComponent(graph));if(project===this.scopeProject&&graph===this.scopeGraph)this.items=items}catch(e){this.error=e.message}finally{this.loading=false} },
    async select(f) { this.selected=f;this.detail=null;this.content='';this.evidence=null;this.error='';this.$refs.findingDialog.showModal();try{const detail=await capabilityRequest('GET','/console/findings/'+encodeURIComponent(f.projectId)+'/'+encodeURIComponent(f.id));let text=typeof detail.details==='string'?detail.details:detail.details?.content||'';if(detail.report?.artifactId){let offset=0,page;do{page=await capabilityRequest('GET','/v2/projects/'+f.projectId+'/evidence/'+detail.report.artifactId+'?graphId='+encodeURIComponent(f.graphId||'')+'&offset='+offset);text+=page.content;offset=page.nextOffset}while(offset!=null)}if(this.selected!==f)return;this.detail=detail;const sections=text.split(/(?=^## )/m);const method=sections.filter(section=>/^## (内容|复现步骤|PoC|利用过程|实际结果|证据)/.test(section)).join('\n');this.content=method.replace(/^## 内容\s*\n/,'').trim()||(!detail.report?text:'')||'尚未记录实际利用方法。可在任务中生成正文。';}catch(e){this.error=e.message} },
    async readEvidence(ref) {this.evidence={ref,content:'',nextOffset:0,error:''};await this.moreEvidence();},
    async moreEvidence() {const e=this.evidence;try{const page=await capabilityRequest('GET','/v2/projects/'+this.selected.projectId+'/evidence/'+e.ref.artifactId+'?graphId='+encodeURIComponent(this.selected.graphId||'')+'&offset='+e.nextOffset);if(e!==this.evidence)return;e.content+=page.content;e.nextOffset=page.nextOffset;}catch(error){e.error=error.message}},
    openGraph(f=this.selected) {this.$refs.findingDialog.close();location.hash='#/projects/'+f.projectId+(f.graphId?'/graphs/'+f.graphId:'');},
  };
};
window.filesPage = function () {
  return {
    projects:[],projectId:'',path:'',directories:{},expanded:{},preview:null,error:'',loading:false,active:false,
    key(project,path=''){return project+':'+path},
    get rows(){const result=[];const walk=(project,path,depth)=>{for(const e of this.directories[this.key(project,path)]||[]){const key=this.key(project,e.path);result.push({...e,key,projectId:project,depth});if(e.type==='directory'&&this.expanded[key])walk(project,e.path,depth+1)}};for(const p of this.projects){const key=this.key(p.id);result.push({key,root:true,projectId:p.id,path:'',name:p.title,type:'directory',depth:0});if(this.expanded[key])walk(p.id,'',1)}return result},
    get entries(){return this.directories[this.key(this.projectId,this.path)]||[]},
    get downloadUrl(){return this.preview?'/audit/tasks/'+this.projectId+'/workspace/download?path='+encodeURIComponent(this.preview.path):''},
    async setActive(active){if(active===this.active)return;this.active=active;if(active)await this.refresh()},
    async refresh(){this.loading=true;this.error='';try{this.projects=await capabilityRequest('GET','/audit/tasks');const ids=new Set(this.projects.map(p=>p.id));for(const map of [this.directories,this.expanded])for(const key of Object.keys(map))if(!ids.has(key.split(':')[0]))delete map[key];if(!ids.has(this.projectId)){this.projectId='';this.path='';this.preview=null}if(this.projectId)await this.loadDirectory(this.path)}catch(e){this.error=e.message}finally{this.loading=false}},
    async loadDirectory(path,project=this.projectId){if(!project)return;this.loading=true;this.error='';try{let offset=0,data;const entries=[];do{data=await capabilityRequest('GET','/audit/tasks/'+project+'/workspace?path='+encodeURIComponent(path)+'&offset='+offset);entries.push(...data.entries);offset=data.nextOffset}while(offset!=null);if(!this.projects.some(p=>p.id===project))return;this.directories[this.key(project,path)]=entries;}catch(e){this.error=e.message}finally{this.loading=false}},
    async openDirectory(path){this.path=path;this.preview=null;this.expanded[this.key(this.projectId,path)]=true;await this.loadDirectory(path)},
    async select(entry){const project=entry.projectId||this.projectId;this.projectId=project;this.preview=null;this.error='';if(entry.type==='directory'){const key=this.key(project,entry.path);this.expanded[key]=!this.expanded[key];this.path=entry.path;if(this.expanded[key])await this.loadDirectory(entry.path,project)}else{this.path=entry.path.split('/').slice(0,-1).join('/');try{const data=await capabilityRequest('GET','/audit/tasks/'+project+'/workspace/file?path='+encodeURIComponent(entry.path));if(project===this.projectId&&this.path===entry.path.split('/').slice(0,-1).join('/'))this.preview=data}catch(e){this.error=e.message}}},
    size(bytes){return bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(1)+' KB':(bytes/1048576).toFixed(1)+' MB'},
  };
};
window.toolsPage = function () {
  return {
    data:{tools:[],roleGroups:{benchmark:['commander','general','soldier','scout'],general:['planner','worker']},runs:[]},
    query:'',source:'',mode:'',role:'',status:'',detail:null,draft:{enabled:true,roles:[]},saving:false,saved:'',error:'',loading:false,active:false,
    usage:null,statsLoading:false,statsFilters:{projectId:'',mode:'',role:'',from:'',to:''},historyTool:'',historyOffset:0,
    get sources(){return [...new Set(this.data.tools.map(t=>t.source))].sort()},
    get roles(){return Object.values(this.data.roleGroups||{}).flat()},
    get filtered(){const q=this.query.trim().toLowerCase(),modeRoles=this.data.roleGroups?.[this.mode];return this.data.tools.filter(t=>(!this.source||t.source===this.source)&&(!modeRoles||(t.roles||[]).some(r=>modeRoles.includes(r)))&&(!this.role||(t.roleBindings||t.roles||[]).includes(this.role))&&(!this.status||(this.status==='enabled'?t.enabled:!t.enabled))&&(!q||(t.name+' '+t.description).toLowerCase().includes(q)))},
    get parameters(){const schema=this.detail?.parameters;return Object.entries(schema?.properties||{}).map(([name,value])=>({name,...value,required:(schema.required||[]).includes(name)}))},
    parameterType(p){return Array.isArray(p.type)?p.type.join(' | '):p.type||(p.enum?'enum':p.anyOf||p.oneOf?'union':'object')},
    title(role){return role.charAt(0).toUpperCase()+role.slice(1)},
    counts(name){return this.usage?.tools.find(t=>t.name===name)||{calls:this.usage?0:'—',succeeded:this.usage?0:'—',failed:this.usage?0:'—',last_call:null}},
    open(tool){this.detail=tool;this.draft={enabled:tool.enabled,roles:[...(tool.roleBindings||[])]};this.saved='';this.error='';this.$refs.toolDialog.showModal()},
    async update(tool,enabled,roles){this.saving=true;this.error='';this.saved='';try{await capabilityRequest('PUT','/console/tools/'+encodeURIComponent(tool.name)+'/settings',{expected_revision:this.data.revision,enabled,roles});this.data=await capabilityRequest('GET','/console/tools');if(this.detail){this.detail=this.data.tools.find(t=>t.id===this.detail.id);if(this.detail)this.draft={enabled:this.detail.enabled,roles:[...this.detail.roleBindings]}}this.saved='已保存，下一模型步骤和新调用生效';}catch(e){this.error=e.message}finally{this.saving=false}},
    async save(){await this.update(this.detail,this.draft.enabled,this.draft.roles)},
    async toggle(tool,event){await this.update(tool,event.target.checked,tool.roleBindings);event.target.checked=this.data.tools.find(t=>t.id===tool.id)?.enabled??tool.enabled},
    async reset(){this.draft={enabled:true,roles:[...this.detail.roles]};await this.save()},
    async setActive(active){if(active===this.active)return;this.active=active;if(active)await this.load()},
    async load(){this.loading=true;this.error='';try{this.data=await capabilityRequest('GET','/console/tools')}catch(e){this.error=e.message}finally{this.loading=false}},
    async openStats(name=''){this.historyTool=name;this.historyOffset=0;this.$refs.statsDialog.showModal();await this.queryStats()},
    async queryStats(reset=true){if(reset)this.historyOffset=0;this.statsLoading=true;this.error='';try{const params=new URLSearchParams();for(const [key,value]of Object.entries(this.statsFilters))if(value)params.set(key,key==='from'||key==='to'?new Date(value).toISOString():value);if(this.historyTool)params.set('tool',this.historyTool);params.set('offset',this.historyOffset);this.usage=await capabilityRequest('GET','/console/tool-stats?'+params)}catch(e){this.error=e.message}finally{this.statsLoading=false}},
    async history(name){this.historyTool=name;await this.queryStats()},
    async pageHistory(delta){this.historyOffset+=delta*100;await this.queryStats(false)},
    time(value){return value?new Date(value).toLocaleString():'—'},
    label(status){return ({registered:'会话已加载',available:'Schema 已定义',unfinished:'未完成',succeeded:'成功',failed:'失败'})[status]||status},
  };
};
