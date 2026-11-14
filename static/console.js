// Management views share the existing engine APIs; no management-side state store.
window.findingsPage = function () {
  return {
    items: [], query: '', severity: '', task: '', type: '', status: '', grouped: true, expanded: {}, detail: null, selected: null, content: '', evidence: null, error: '', loading: false, active: false,
    severityLabel(value) { return ({critical:'严重',high:'高危',medium:'中危',low:'低危'})[value] || '未评级'; },
    statusLabel(value) { return ({active:'进行中',stopped:'已停止',completed:'已完成'})[value] || value; },
    get stats() { return ['critical','high','medium','low'].map(key => ({key,label:this.severityLabel(key),count:this.items.filter(f=>f.severity===key).length})); },
    get tasks() { return [...new Map(this.items.map(f=>[f.projectId,{id:f.projectId,title:f.projectTitle}])).values()]; },
    get types() { return [...new Set(this.items.map(f=>f.type))].sort(); },
    get filtered() { const q=this.query.trim().toLowerCase();return this.items.filter(f=>(!this.severity||f.severity===this.severity)&&(!this.task||f.projectId===this.task)&&(!this.type||f.type===this.type)&&(!this.status||f.projectStatus===this.status)&&(!q||[f.title,f.description,f.type,...(f.assetIds||[])].join(' ').toLowerCase().includes(q))); },
    get groups() { const groups=new Map();for(const f of this.filtered){if(!groups.has(f.projectId))groups.set(f.projectId,{id:f.projectId,title:f.projectTitle,status:f.projectStatus,items:[]});groups.get(f.projectId).items.push(f)}return [...groups.values()]; },
    async setActive(active) { if(active===this.active)return;this.active=active;if(active)await this.load(); },
    async load() { this.loading=true;this.error='';try{this.items=await capabilityRequest('GET','/console/findings')}catch(e){this.error=e.message}finally{this.loading=false} },
    async select(f) { this.selected=f;this.detail=null;this.content='';this.evidence=null;this.error='';this.$refs.findingDialog.showModal();try{const detail=await capabilityRequest('GET','/console/findings/'+encodeURIComponent(f.projectId)+'/'+encodeURIComponent(f.id));let text=typeof detail.details==='string'?detail.details:detail.details?.content||'';if(detail.report?.artifactId){let offset=0,page;do{page=await capabilityRequest('GET','/v2/projects/'+f.projectId+'/evidence/'+detail.report.artifactId+'?graphId='+encodeURIComponent(f.graphId||'')+'&offset='+offset);text+=page.content;offset=page.nextOffset}while(offset!=null)}if(this.selected!==f)return;this.detail=detail;const sections=text.split(/(?=^## )/m);const method=sections.filter(section=>/^## (内容|复现步骤|PoC|利用过程|实际结果|证据)/.test(section)).join('\n');this.content=method.replace(/^## 内容\s*\n/,'').trim()||(!detail.report?text:'')||'尚未记录实际利用方法。可在任务中生成正文。';}catch(e){this.error=e.message} },
    async readEvidence(ref) {this.evidence={ref,content:'',nextOffset:0,error:''};await this.moreEvidence();},
    async moreEvidence() {const e=this.evidence;try{const page=await capabilityRequest('GET','/v2/projects/'+this.selected.projectId+'/evidence/'+e.ref.artifactId+'?graphId='+encodeURIComponent(this.selected.graphId||'')+'&offset='+e.nextOffset);if(e!==this.evidence)return;e.content+=page.content;e.nextOffset=page.nextOffset;}catch(error){e.error=error.message}},
    openGraph(f=this.selected) {this.$refs.findingDialog.close();location.hash='#/projects/'+f.projectId+(f.graphId?'/graphs/'+f.graphId:'');},
  };
};
window.filesPage = function () {
  return {
    projects: [], projectId: '', path: '', directories: {}, expanded: {}, preview: null, error: '', loading: false, active: false,
    get rows() {const result=[];const walk=(dir,depth)=>{for(const e of this.directories[dir]||[]){result.push({...e,depth});if(e.type==='directory'&&this.expanded[e.path])walk(e.path,depth+1)}};walk('',0);return result},
    get entries() {return this.directories[this.path]||[]},
    get downloadUrl() {return this.preview?'/audit/tasks/'+this.projectId+'/workspace/download?path='+encodeURIComponent(this.preview.path):''},
    async setActive(active) {if(active===this.active)return;this.active=active;if(active){try{this.projects=await capabilityRequest('GET','/audit/tasks');if(!this.projects.some(p=>p.id===this.projectId))this.projectId=this.projects[0]?.id||'';if(this.projectId)await this.changeProject()}catch(e){this.error=e.message}}},
    async changeProject() {this.path='';this.directories={};this.expanded={};this.preview=null;this.error='';if(this.projectId)await this.loadDirectory('')},
    async loadDirectory(path) {const project=this.projectId;this.loading=true;this.error='';try{let offset=0,data;const entries=[];do{data=await capabilityRequest('GET','/audit/tasks/'+project+'/workspace?path='+encodeURIComponent(path)+'&offset='+offset);entries.push(...data.entries);offset=data.nextOffset}while(offset!=null);if(project!==this.projectId)return;this.directories[path]=entries;this.path=path;this.preview=null;}catch(e){this.error=e.message}finally{this.loading=false}},
    async select(entry) {if(entry.type==='directory'){this.expanded[entry.path]=!this.expanded[entry.path];await this.loadDirectory(entry.path)}else{const project=this.projectId;this.preview=null;this.error='';try{const data=await capabilityRequest('GET','/audit/tasks/'+project+'/workspace/file?path='+encodeURIComponent(entry.path));if(project===this.projectId)this.preview=data}catch(e){this.error=e.message;this.preview={path:entry.path,content:'',binary:true}}}},
    size(bytes) {return bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(1)+' KB':(bytes/1048576).toFixed(1)+' MB'},
  };
};
window.toolsPage = function () {
  return {
    data: {tools:[],calls:[],stats:{}}, query:'', source:'', status:'', selected:'', detail:null, draft:{enabled:true,workers:[]}, saving:false, saved:'', error:'', loading:false, active:false,
    get sources(){return [...new Set(this.data.tools.map(t=>t.source))].sort()},
    get filtered(){const q=this.query.trim().toLowerCase();return this.data.tools.filter(t=>(!this.source||t.source===this.source)&&(!this.status||t.status===this.status)&&(!q||(t.name+' '+t.description).toLowerCase().includes(q)))},
    get parameters(){const schema=this.detail?.parameters;return Object.entries(schema?.properties||{}).map(([name,value])=>({name,...value,required:(schema.required||[]).includes(name)}))},
    parameterType(p){return Array.isArray(p.type)?p.type.join(' | '):p.type||(p.enum?'enum':p.anyOf||p.oneOf?'union':'object')},
    open(tool){this.detail=tool;this.selected=tool.name;this.draft={enabled:tool.enabled,workers:[...(tool.workerBindings||[])]};this.saved='';this.error='';this.$refs.toolDialog.showModal()},
    async save(){this.saving=true;this.error='';this.saved='';try{await capabilityRequest('PUT','/console/tools/'+encodeURIComponent(this.detail.name)+'/settings',{expected_revision:this.data.revision,enabled:this.draft.enabled,workers:this.draft.workers});const key=this.detail.source+':'+this.detail.name;this.data=await capabilityRequest('GET','/console/tools');this.detail=this.data.tools.find(t=>t.source+':'+t.name===key);this.saved='已保存，后续新调用立即生效';}catch(e){this.error=e.message}finally{this.saving=false}},
    async reset(){this.draft={enabled:true,workers:this.data.workers.map(w=>w.name)};await this.save()},
    get records(){return this.data.calls.filter(c=>!this.selected||c.name===this.selected)},
    async setActive(active){if(active===this.active)return;this.active=active;if(active)await this.load()},
    async load(){this.loading=true;this.error='';try{this.data=await capabilityRequest('GET','/console/tools')}catch(e){this.error=e.message}finally{this.loading=false}},
    label(status){return ({registered:'已注册',available:'可用',unavailable:'PATH 不可用',inactive:'当前未注册'})[status]||status},
  };
};
