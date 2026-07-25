function auditPage() {
  return {
    active: false,
    initialized: false,
    loading: false,
    tasks: [],
    runs: [],
    events: [],
    selectedTaskId: '',
    selectedProvider: 'all',
    selectedWorker: 'all',
    taskQuery: '',
    autoFollow: true,
    source: null,
    workspacePath: '',
    workspaceSource: '',
    workspaceEntries: [],
    selectedFile: null,
    fileLoading: false,
    error: '',

    async setActive(active) {
      if (this.active === active) return;
      this.active = active;
      if (!active) {
        this.disconnectStream();
        return;
      }
      if (!this.initialized) {
        await this.initAudit();
      } else if (this.selectedTaskId) {
        this.connectStream();
      }
    },

    async initAudit() {
      this.initialized = true;
      this.loading = true;
      try {
        await this.loadTasks();
        if (this.tasks.length) await this.selectTask(this.tasks[0].id);
      } catch (error) {
        this.error = error.message;
      } finally {
        this.loading = false;
      }
    },

    async request(path) {
      const response = await fetch(path);
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (!response.ok) throw new Error(data?.detail || text || `HTTP ${response.status}`);
      return data;
    },

    async loadTasks() {
      this.tasks = await this.request('/audit/tasks');
    },

    filteredTasks() {
      const query = this.taskQuery.trim().toLowerCase();
      if (!query) return this.tasks;
      return this.tasks.filter(task =>
        task.title.toLowerCase().includes(query) || task.id.toLowerCase().includes(query)
      );
    },

    selectedTask() {
      return this.tasks.find(task => task.id === this.selectedTaskId) || null;
    },

    async selectTask(projectId) {
      if (!projectId) return;
      this.disconnectStream();
      this.selectedTaskId = projectId;
      this.selectedProvider = 'all';
      this.selectedWorker = 'all';
      this.events = [];
      this.runs = [];
      this.workspacePath = '';
      this.workspaceEntries = [];
      this.selectedFile = null;
      this.error = '';
      const results = await Promise.allSettled([
        this.request(`/audit/tasks/${encodeURIComponent(projectId)}/runs`),
        this.request(`/audit/tasks/${encodeURIComponent(projectId)}/events?limit=200`),
        this.loadWorkspace(''),
      ]);
      if (results[0].status === 'fulfilled') this.runs = results[0].value;
      if (results[1].status === 'fulfilled') this.events = results[1].value;
      if (results[1].status === 'rejected') this.error = results[1].reason.message;
      if (this.active) this.connectStream();
      this.$nextTick(() => this.scrollToBottom());
    },

    connectStream() {
      if (!this.active || !this.selectedTaskId || this.source) return;
      const source = new EventSource(
        `/audit/tasks/${encodeURIComponent(this.selectedTaskId)}/stream`
      );
      source.addEventListener('audit', event => {
        this.applyEvent(JSON.parse(event.data));
      });
      source.onerror = () => {};
      this.source = source;
    },

    disconnectStream() {
      this.source?.close();
      this.source = null;
    },

    applyEvent(event) {
      if (event.kind === 'assistant.delta') {
        let current = null;
        for (let index = this.events.length - 1; index >= 0; index -= 1) {
          const candidate = this.events[index];
          if (candidate.run_id !== event.run_id) continue;
          if (candidate.kind === 'assistant.delta' && !candidate.closed) current = candidate;
          break;
        }
        if (current) {
          current.content = `${current.content || ''}${event.content || ''}`;
        } else {
          this.events.push({ ...event, content: event.content || '' });
        }
      } else {
        for (let index = this.events.length - 1; index >= 0; index -= 1) {
          if (this.events[index].run_id === event.run_id && this.events[index].kind === 'assistant.delta') {
            this.events[index].closed = true;
            break;
          }
        }
        this.events.push(event);
      }
      if (event.kind === 'run.started' || event.kind === 'run.completed') {
        this.refreshRuns();
        this.loadTasks();
      }
      if (this.autoFollow) this.$nextTick(() => this.scrollToBottom());
    },

    async refreshRuns() {
      if (!this.selectedTaskId) return;
      this.runs = await this.request(
        `/audit/tasks/${encodeURIComponent(this.selectedTaskId)}/runs`
      );
    },

    workers() {
      return [...new Set(this.runs.map(run => run.worker))].sort();
    },

    eventVisible(event) {
      if (event.kind === 'run.started' || event.kind === 'session.started' || event.kind === 'turn.started') {
        return false;
      }
      if (this.selectedProvider !== 'all' && event.provider !== this.selectedProvider) return false;
      return this.selectedWorker === 'all' || event.worker === this.selectedWorker;
    },

    providerLabel(provider) {
      return { claudecode: 'Claude Code', codex: 'Codex', pi: 'Pi', mock: 'Mock' }[provider] || provider;
    },

    providerClass(provider) {
      return `provider-${provider || 'mock'}`;
    },

    providerDotClass(provider) {
      return `provider-dot-${provider || 'mock'}`;
    },

    eventAction(event) {
      const labels = {
        'user.message': '用户',
        'assistant.message': '助手',
        'assistant.delta': '助手',
        'tool.started': event.title || '工具',
        'tool.completed': event.title || '工具结果',
        'command.started': '执行',
        'command.completed': '执行',
        'file.changed': '修改',
        'turn.completed': '回合结束',
        'run.completed': '运行结束',
        error: '错误',
        stderr: 'stderr',
      };
      return labels[event.kind] || event.kind;
    },

    isMessage(event) {
      return ['user.message', 'assistant.message', 'assistant.delta'].includes(event.kind);
    },

    isTool(event) {
      return ['tool.started', 'tool.completed', 'file.changed'].includes(event.kind);
    },

    isCommand(event) {
      return ['command.started', 'command.completed'].includes(event.kind);
    },

    eventPayload(event) {
      if (event.command) return event.command;
      if (event.content) return event.content;
      if (event.arguments) {
        try { return JSON.stringify(event.arguments, null, 2); } catch {}
      }
      if (event.changes) {
        try { return JSON.stringify(event.changes, null, 2); } catch {}
      }
      return '';
    },

    runFor(event) {
      return this.runs.find(run => run.id === event.run_id) || null;
    },

    formatTime(value) {
      if (!value) return '';
      return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },

    formatDate(value) {
      if (!value) return '';
      return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' });
    },

    formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    },

    scrollToBottom() {
      const scroller = this.$refs.auditTimeline;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    },

    async loadWorkspace(path = '') {
      if (!this.selectedTaskId) return;
      const query = new URLSearchParams({ path });
      try {
        const data = await this.request(
          `/audit/tasks/${encodeURIComponent(this.selectedTaskId)}/workspace?${query}`
        );
        this.workspacePath = data.path || '';
        this.workspaceSource = data.source || '';
        this.workspaceEntries = data.entries || [];
      } catch (error) {
        this.workspaceEntries = [];
        this.workspaceSource = '';
      }
    },

    workspaceCrumbs() {
      const parts = this.workspacePath.split('/').filter(Boolean);
      const crumbs = [{ label: 'workspace', path: '' }];
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        crumbs.push({ label: part, path: current });
      }
      return crumbs;
    },

    async openWorkspaceEntry(entry) {
      if (entry.type === 'directory') {
        this.selectedFile = null;
        await this.loadWorkspace(entry.path);
        return;
      }
      this.fileLoading = true;
      try {
        this.selectedFile = await this.request(
          `/audit/tasks/${encodeURIComponent(this.selectedTaskId)}/workspace/file?path=${encodeURIComponent(entry.path)}`
        );
      } catch (error) {
        this.selectedFile = { path: entry.path, content: '', binary: true, error: error.message };
      } finally {
        this.fileLoading = false;
      }
    },
  };
}
