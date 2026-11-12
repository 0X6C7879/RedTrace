const methods = {
    legionProject(id){return this.legion?.projects.find(p=>p.id===id)},
    legionProjectTitle(id){return this.legionProject(id)?.title||id||'未选择项目'},
    legionTaskTitle(project,key){return project?.steps.find(s=>s.taskKey===key&&!s.parentStepId)?.description||project?.steps.find(s=>s.taskKey===key)?.description||key||'—'},
    legionTaskFinished(project,key){const steps=project.steps.filter(s=>s.taskKey===key);return steps.length>0&&steps.every(s=>['done','cancelled'].includes(s.status))},
    legionRole(role){return ({commander:'Commander',general:'General',soldier:'Soldier',scout:'Scout'})[role]||'未标注角色'},
    legionStatus(status){return ({idle:'待命',running:'执行中',stopped:'执行已停止',active:'进行中',pending:'待执行',paused:'执行暂停（非 Park）',parked:'已搁置 · Park',unknown:'结果待核验',done:'已完成',success:'成功',failed:'失败',cancelled:'已取消',queued:'已排队，未入模',admitted:'已入模',uncertain:'交付不确定',delivered:'已交付',acknowledged:'已确认', 'needs-reverification':'待目标复验','target-verified':'目标已复验'})[status]||status||'未知'},
    legionPhase(phase){return ({open:'未设时限',campaign:'推进中',endgame:'收尾',submission:'仅提交',ended:'已截止'})[phase]||phase||'—'},
    legionDifficulty(value){return ({easy:'Scout：简单',medium:'Scout：中等',hard:'Scout：困难',unclear:'Scout：尚不明确'})[value]||'待 Scout 分类'},
    legionRecommendation(value){return ({scout:'建议 Scout 分类',general:'建议 General 协调',park:'建议搁置',parked:'已搁置',tactical:'建议战术纠偏','second-angle':'建议第二视角'})[value]||value},
    legionRecipients(projectId){return (this.legionProject(projectId)?.runs||[]).filter(r=>['running','paused'].includes(r.status))},
    legionRunLabel(projectId,run){const p=this.legionProject(projectId),step=p?.steps.find(s=>s.id===run.stepId);return this.legionRole(step?.role)+' · '+(step?.description||run.worker)+' · '+this.legionStatus(run.status)+' · '+run.id},
    legionWorkers(project,run){if(!project||!run)return[];const role=project.steps.find(s=>s.id===run.stepId)?.role||'soldier';return (this.workerConfig.workers||[]).filter(w=>w.enabled&&w.name!==run.worker&&w.roles?.includes(role))},
    legionResumeBlock(project,taskKey){if(project.status!=='active')return'项目不在进行中';const steps=project.steps.filter(s=>s.taskKey===taskKey);if(steps.some(s=>s.handoffPending))return'交接尚未确认旧执行停止';if(project.runs.some(r=>steps.some(s=>s.id===r.stepId)&&['running','paused','unknown'].includes(r.status)))return'旧执行仍运行、暂停或结果未知，请先核验停止';return''},
    async loadLegion(){this.legionLoading=true;try{this.legion=await this.api('GET','/v2/legion');this.legionUpdatedAt=Date.now();this.legionError=''}catch(error){this.legionError='状态更新失败，显示的可能是旧快照：'+error.message}finally{this.legionLoading=false}},
    async legionAction(path, body, message = '已保存') {
      this.legionPending[path] = true;
      this.legionEditorError = '';
      this.legionNotice = '';
      try {
        const result = await this.api('POST', path, body);
        await this.loadLegion();
        if (result?.unresolved?.length) {
          this.legionNotice = '恢复未全部完成，需核验：' + JSON.stringify(result.unresolved);
          return false;
        }
        this.showToast(message);
        return true;
      } catch (error) {
        this.legionEditorError = error.message;
        this.legionNotice = error.message;
        this.showToast(error.message, 'error');
        return false;
      } finally {
        this.legionPending[path] = false;
      }
    },
    async setLegionDeadline(){const deadline=Date.parse(this.legionDeadline);if(!Number.isFinite(deadline)||deadline<=Date.now()){this.showToast('请选择本机时区的未来截止时间','error');return}await this.legionAction('/v2/legion/deadline',{deadline},'截止时间已保存')},
    openLegionEditor(kind,project,values={}){if(!project)return;this.legionEditor={kind,projectId:project.id,taskKey:'',runId:'',reason:'',resumeCondition:'',summary:'',nextWorker:'',factIds:[],...values};if(values.runId)this.legionEditor.taskKey=project.steps.find(s=>s.id===project.runs.find(r=>r.id===values.runId)?.stepId)?.taskKey||'';this.legionEditorError='';if(kind==='confirm')this.loadLegionFacts(project.id);this.$nextTick(()=>this.$refs.legionEditorDialog.showModal())},
    closeLegionEditor(){this.$refs.legionEditorDialog.close()},
    async submitLegionEditor(){const e=this.legionEditor;let url,body,message;if(e.kind==='park'){url='/v2/projects/'+encodeURIComponent(e.projectId)+'/legion/park';body={taskKey:e.taskKey,reason:e.reason,resumeCondition:e.resumeCondition};message='题目已搁置；请核验执行停止状态'}else if(e.kind==='resume'){url='/v2/projects/'+encodeURIComponent(e.projectId)+'/legion/reactivate';body={taskKey:e.taskKey,reason:e.reason};message='题目已恢复为待执行'}else if(e.kind==='reassign'){url='/v2/legion/reassign';body={projectId:e.projectId,runId:e.runId,nextWorker:e.nextWorker,summary:e.summary};message='交接请求已保存，等待旧执行停止确认'}else if(e.kind==='confirm'){url='/v2/legion/transfer/'+encodeURIComponent(e.transferId)+'/confirm';body={projectId:e.projectId,factIds:[...e.factIds]};message='目标复验已登记'}else return;this.legionEditorSaving=true;try{if(await this.legionAction(url,body,message)&&this.legionEditor===e)this.closeLegionEditor()}finally{this.legionEditorSaving=false}},
    async sendLegionMessage(){if(await this.legionAction('/v2/legion/message',{...this.legionMessage},'消息已保存；实际交付请查看消息状态'))this.legionMessage.content=''},
    async searchLegionExperience(){this.legionSearching=true;this.legionSearched=false;try{this.legionResults=await this.api('GET','/v2/legion/experience?query='+encodeURIComponent(this.legionQuery));this.legionSearched=true}catch(error){this.showToast(error.message,'error')}finally{this.legionSearching=false}},
    async readLegionExperience(item,more=false){this.legionReading=true;const offset=more?this.legionPreviewMeta?.nextOffset:0;if(!more){this.legionPreviewItem=item;this.legionPreview='';this.legionPreviewMeta=null}try{const page=await this.api('GET','/v2/projects/'+encodeURIComponent(item.projectId)+'/evidence/'+encodeURIComponent(item.artifactId)+'?offset='+offset);if(this.legionPreviewItem?.id!==item.id)return;if(page.encoding==='base64')throw Error('此证据为二进制，不能作为文本预览');this.legionPreview+=page.content;this.legionPreviewMeta={...page,bytes:page.offset+page.bytes}}catch(error){this.showToast(error.message,'error')}finally{this.legionReading=false}},
    async loadLegionFacts(projectId){if(!projectId)return;this.legionFactLoading[projectId]=true;this.legionFactErrors[projectId]='';try{this.legionFacts[projectId]=await this.api('GET','/v2/projects/'+encodeURIComponent(projectId)+'/facts')}catch(error){this.legionFacts[projectId]=[];this.legionFactErrors[projectId]=error.message}finally{this.legionFactLoading[projectId]=false}},
    legionFactOptions(projectId,taskKey){const p=this.legionProject(projectId);return (this.legionFacts[projectId]||[]).filter(f=>f.id!=='origin'&&(!taskKey||p?.steps.some(s=>s.id===f.stepId&&s.taskKey===taskKey)))},
    async captureLegionExperience(){await this.legionAction('/v2/legion/experience',{...this.legionCapture,factIds:[...this.legionCapture.factIds]},'来源经验已保存并索引')},
    async transferLegionExperience(){await this.legionAction('/v2/legion/transfer',{...this.legionTransfer,sourceId:Number(this.legionTransfer.sourceId)},'已发送未验证 Hint；仍需目标题目实际复验')},


};