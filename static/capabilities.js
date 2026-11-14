async function capabilityRequest(method, path, body) {
  const options = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return data;
}

window.skillsPage = function skillsPage() {
  return {
    status: null,
    items: [],
    query: '',
    verbs: null,
    usage: { calls: [] }, folders: {}, filePath: 'SKILL.md', fileContent: '', active: false,
    selectedName: '',
    draft: null,
    versions: [],
    rollbackVersion: '',
    isNew: false,
    loading: false,
    saving: false,
    deleteArmed: false,
    deleteTimer: null,
    message: '',
    messageType: 'info',

    get enabledCount() {
      // Nested entries inherit enabled from their root package, so one
      // count over the unified list already covers in-package Skills.
      return this.items.filter((item) => !item.nested && item.enabled).length;
    },

    get filteredItems() {
      const needle = this.query.trim().toLowerCase();
      return this.items.filter((item) =>
        (!needle || `${item.name} ${item.description || ''} ${item.parent || ''} ${item.path || ''}`
          .toLowerCase().includes(needle))
      );
    },

    async init() {},
    async setActive(active) { if (active === this.active) return; this.active = active; if (active) await this.load(); },

    async load() {
      this.loading = true;
      this.setMessage('');
      try {
        // Status and the unified entry list load in parallel and fail
        // independently: a partial outage must not blank the page.
        const [statusResult, entriesResult, verbsResult] = await Promise.allSettled([
          capabilityRequest('GET', '/capabilities'),
          capabilityRequest('GET', '/capabilities/skill-entries'),
          capabilityRequest('GET', '/console/tools'),
        ]);
        if (statusResult.status === 'fulfilled') {
          this.status = statusResult.value;
        }
        if (entriesResult.status === 'fulfilled') {
          this.items = entriesResult.value;
        }
        if (verbsResult.status === 'fulfilled') this.usage = verbsResult.value;
        const failures = [statusResult, entriesResult, verbsResult]
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason?.message || String(result.reason));
        if (failures.length) {
          this.setMessage(failures.join('；'), 'error');
        }
        const selected = this.filteredItems.find((item) => item.key === this.selectedName);
        if (selected) {
          await this.select(selected);
        } else if (!this.isNew) {
          this.selectedName = '';
          this.draft = null;
        }
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    get fileTree() {const entries=[],seen=new Set();for(const file of [...(this.draft?.files||[])].sort()){const parts=file.split('/');for(let i=1;i<parts.length;i++){const dir=parts.slice(0,i).join('/');if(!seen.has(dir)){seen.add(dir);entries.push({path:dir,name:parts[i-1],depth:i-1,directory:true})}}entries.push({path:file,name:parts.at(-1),depth:parts.length-1,directory:false})}return entries.filter(entry=>entry.path.split('/').slice(0,-1).every((_,i)=>this.folders[entry.path.split('/').slice(0,i+1).join('/')]!==false));},
    get skillCalls() { const selected=this.items.find(item=>item.key===this.selectedName);const name=selected?.nested?null:selected?.name;return this.usage.calls.filter(call=>call.name==='skill' && call.arguments?.name===name); },
    get previewContent() { return this.filePath==='SKILL.md'?this.draft?.content||'':this.fileContent; },
    async selectFile(file) {this.filePath=file;if(file==='SKILL.md')return;try{const data=await capabilityRequest('GET','/capabilities/skills/'+encodeURIComponent(this.draft.name)+'/files/'+file.split('/').map(encodeURIComponent).join('/'));if(this.filePath===file)this.fileContent=data.binary?'二进制文件，不支持文本预览':data.content;}catch(e){this.setMessage(e.message,'error')}},
    async select(item) {
      this.filePath='SKILL.md';this.fileContent='';this.folders={};
      this.isNew = false;
      this.deleteArmed = false;
      this.selectedName = item.key || item.name;
      this.rollbackVersion = '';
      this.setMessage('');
      try {
        if (item.nested) {
          const path = item.path.split('/').map(encodeURIComponent).join('/');
          this.draft = await capabilityRequest(
            'GET',
            `/capabilities/skills/${encodeURIComponent(item.parent)}/entries/${path}`,
          );
          this.draft.enabled = this.items.find(
            (entry) => !entry.nested && entry.name === item.parent,
          )?.enabled ?? false;
          this.versions = [];
          return;
        }
        const name = item.parent || item.name;
        const [draft, versions] = await Promise.all([
          capabilityRequest('GET', `/capabilities/skills/${encodeURIComponent(name)}`),
          capabilityRequest('GET', `/capabilities/skills/${encodeURIComponent(name)}/versions`),
        ]);
        this.draft = draft;
        this.versions = versions;
      } catch (error) {
        this.setMessage(error.message, 'error');
      }
    },

    createNew() {
      this.filePath = 'SKILL.md'; this.fileContent = ''; this.folders = {};
      this.isNew = true;
      this.selectedName = '';
      this.deleteArmed = false;
      this.setMessage('');
      this.draft = {
        name: '',
        enabled: true,
        files: [],
        content: '---\nname: skill-name\ndescription: Describe when this skill should be used.\n---\n\n# Skill name\n\nAdd the workflow and any required rules here.\n',
      };
      this.versions = [];
      this.rollbackVersion = '';
    },

    async save() {
      if (!this.draft || this.draft.nested || this.saving) return;
      this.saving = true;
      this.setMessage('');
      try {
        const path = this.isNew
          ? '/capabilities/skills'
          : `/capabilities/skills/${encodeURIComponent(this.draft.name)}`;
        const body = this.isNew
          ? { name: this.draft.name, content: this.draft.content, enabled: this.draft.enabled }
          : {
              content: this.draft.content,
              enabled: this.draft.enabled,
              expected_revision: this.draft.revision,
            };
        const saved = await capabilityRequest(this.isNew ? 'POST' : 'PUT', path, body);
        this.isNew = false;
        this.selectedName = saved.name;
        this.draft = saved;
        this.setMessage('已保存，将在下一个 agent 任务中自动同步。', 'success');
        await this.refreshList();
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.saving = false;
      }
    },

    async refreshList() {
      this.items = await capabilityRequest('GET', '/capabilities/skill-entries');
    },

    async rollback() {
      if (!this.draft || !this.rollbackVersion || this.saving) return;
      const version = Number(this.rollbackVersion);
      if (!Number.isInteger(version)) return;
      if (!window.confirm(`将 ${this.draft.name} 回滚到 v${version}？当前内容会作为新历史版本保留。`)) return;
      this.saving = true;
      this.setMessage('');
      try {
        this.draft = await capabilityRequest(
          'POST',
          `/capabilities/skills/${encodeURIComponent(this.draft.name)}/rollback/${version}`,
          { expected_revision: this.draft.revision },
        );
        this.setMessage(`已回滚到 v${version}，并保留完整历史。`, 'success');
        await this.load();
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.saving = false;
      }
    },

    armDelete() {
      this.deleteArmed = true;
      clearTimeout(this.deleteTimer);
      this.deleteTimer = setTimeout(() => { this.deleteArmed = false; }, 4000);
    },

    async remove() {
      if (!this.draft || this.draft.nested || this.isNew) return;
      const name = this.draft.name;
      try {
        await capabilityRequest('DELETE', `/capabilities/skills/${encodeURIComponent(name)}`);
        this.selectedName = '';
        this.draft = null;
        this.deleteArmed = false;
        await this.refreshList();
      } catch (error) {
        this.setMessage(error.message, 'error');
      }
    },

    setMessage(message, type = 'info') {
      this.message = message;
      this.messageType = type;
    },
  };
};

window.mcpPage = function mcpPage() {
  return {
    status: null,
    live: {tools:[],mcp:[]}, active: false,
    items: [],
    query: '',
    selectedName: '',
    draft: null,
    isNew: false,
    loading: false,
    saving: false,
    deleteArmed: false,
    deleteTimer: null,
    message: '',
    messageType: 'info',

    get enabledCount() {
      return this.items.filter((item) => item.enabled).length;
    },

    get filteredItems() {
      const needle = this.query.trim().toLowerCase();
      if (!needle) return this.items;
      return this.items.filter((item) =>
        `${item.name} ${item.transport || ''} ${item.command || ''} ${item.url || ''}`
          .toLowerCase()
          .includes(needle)
      );
    },

    async init() {},
    async setActive(active) {if(active===this.active)return;this.active=active;if(active)await this.load();},

    async load() {
      this.loading = true;
      this.setMessage('');
      try {
        const [status, items, live] = await Promise.all([
          capabilityRequest('GET', '/capabilities'),
          capabilityRequest('GET', '/capabilities/mcp'),
          capabilityRequest('GET', '/console/tools'),
        ]);
        this.status = status; this.live = live;
        this.items = items;
        if (this.selectedName && items.some((item) => item.name === this.selectedName)) {
          await this.select(this.selectedName);
        } else if (!this.isNew) {
          this.selectedName = '';
          this.draft = null;
        }
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    connection(name) {const state=this.live.mcp.find(server=>server.name===name)?.state;if(state)return ({connected:'已连接',connecting:'连接中',reconnecting:'重连中',failed:'连接失败',closed:'已关闭','waiting-credentials':'等待凭证'})[state]||state;const item=this.items.find(s=>s.name===name);return item?(item.enabled?'未挂载':'已停用'):'读取中…';},
    serverTools(name) {return this.live.tools.filter(tool=>tool.name.startsWith('mcp__'+name+'__'));},
    async select(name) {
      this.isNew = false;
      this.deleteArmed = false;
      this.selectedName = name;
      this.setMessage('');
      try {
        const server = await capabilityRequest('GET', `/capabilities/mcp/${encodeURIComponent(name)}`);
        this.draft = {
          name: server.name,
          enabled: server.enabled,
          raw: JSON.stringify(server.config, null, 2),
        };
      } catch (error) {
        this.setMessage(error.message, 'error');
      }
    },

    createNew() {
      this.isNew = true;
      this.selectedName = '';
      this.deleteArmed = false;
      this.setMessage('');
      this.draft = {
        name: '',
        enabled: true,
        raw: JSON.stringify({
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'your-mcp-package'],
          env: {},
          agents: {},
        }, null, 2),
      };
    },

    async save() {
      if (!this.draft || this.saving) return;
      this.saving = true;
      this.setMessage('');
      try {
        const config = JSON.parse(this.draft.raw);
        if (!config || Array.isArray(config) || typeof config !== 'object') {
          throw new Error('MCP JSON 的根值必须是对象。');
        }
        config.enabled = this.draft.enabled;
        const path = this.isNew
          ? '/capabilities/mcp'
          : `/capabilities/mcp/${encodeURIComponent(this.draft.name)}`;
        const body = this.isNew ? { name: this.draft.name, config } : { config };
        const saved = await capabilityRequest(this.isNew ? 'POST' : 'PUT', path, body);
        this.isNew = false;
        this.selectedName = saved.name;
        this.draft = {
          name: saved.name,
          enabled: saved.enabled,
          raw: JSON.stringify(saved.config, null, 2),
        };
        this.setMessage('已保存，并按原生运行时刷新连接。', 'success');
        await this.refreshList();
      } catch (error) {
        this.setMessage(error instanceof SyntaxError ? `JSON 语法错误：${error.message}` : error.message, 'error');
      } finally {
        this.saving = false;
      }
    },

    async refreshList() {
      const [items,live] = await Promise.all([capabilityRequest('GET','/capabilities/mcp'),capabilityRequest('GET','/console/tools')]); this.items=items; this.live=live;
    },

    armDelete() {
      this.deleteArmed = true;
      clearTimeout(this.deleteTimer);
      this.deleteTimer = setTimeout(() => { this.deleteArmed = false; }, 4000);
    },

    async remove() {
      if (!this.draft || this.isNew) return;
      try {
        await capabilityRequest('DELETE', `/capabilities/mcp/${encodeURIComponent(this.draft.name)}`);
        this.selectedName = '';
        this.draft = null;
        this.deleteArmed = false;
        await this.refreshList();
      } catch (error) {
        this.setMessage(error.message, 'error');
      }
    },

    setMessage(message, type = 'info') {
      this.message = message;
      this.messageType = type;
    },
  };
};
