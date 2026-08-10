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
    renderWindow: 150,
    RENDER_BATCH: 100,
    EVENT_BUFFER_LIMIT: 2000,
    _completedKeys: new Set(),
    _openThinking: {},
    _eventKeys: new Set(),
    _pendingEvents: [],
    _frameRequest: 0,

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
        await this.selectTask(this.selectedTaskId);
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
      this.renderWindow = 150;
      this._completedKeys = new Set();
      this._openThinking = {};
      this._eventKeys = new Set();
      this._hasServerMore = true;
      this._loadingMore = false;
      this.workspacePath = '';
      this.workspaceEntries = [];
      this.selectedFile = null;
      this.error = '';
      const results = await Promise.allSettled([
        this.request(`/audit/tasks/${encodeURIComponent(projectId)}/runs`),
        this.request(`/audit/tasks/${encodeURIComponent(projectId)}/events?limit=500`),
        this.loadWorkspace(''),
      ]);
      if (results[0].status === 'fulfilled') this.runs = results[0].value;
      if (results[1].status === 'fulfilled') {
        this.events = results[1].value;
        this.reindexEvents();
        if (this.events.length < 500) this._hasServerMore = false;
      }
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
        try { this.queueEvent(JSON.parse(event.data)); } catch (_) {}
      });
      source.onerror = () => {};
      this.source = source;
    },

    disconnectStream() {
      this.source?.close();
      this.source = null;
      if (this._frameRequest) cancelAnimationFrame(this._frameRequest);
      this._frameRequest = 0;
      this._pendingEvents = [];
    },

    queueEvent(event) {
      this._pendingEvents.push(event);
      if (this._frameRequest) return;
      this._frameRequest = requestAnimationFrame(() => {
        this._frameRequest = 0;
        const pending = this._pendingEvents.splice(0);
        for (const item of pending) this.applyEvent(item);
        this.trimEventBuffer();
        if (this.autoFollow) this.$nextTick(() => this.scrollToBottom());
      });
    },

    applyEvent(event) {
      const deltaKinds = ['assistant.delta', 'thinking.delta'];
      if (deltaKinds.includes(event.kind)) {
        let current = null;
        for (let index = this.events.length - 1; index >= 0; index -= 1) {
          const candidate = this.events[index];
          if (candidate.run_id !== event.run_id) continue;
          if (candidate.kind === event.kind && !candidate.closed) current = candidate;
          break;
        }
        if (current) {
          current.content = `${current.content || ''}${event.content || ''}`;
        } else {
          this.closeOpenDelta(event.run_id, deltaKinds);
          const item = { ...event, content: event.content || '' };
          this.events.push(item);
          this.indexEvent(item);
        }
      } else {
        this.closeOpenDelta(event.run_id, deltaKinds);
        this.events.push(event);
        this.indexEvent(event);
      }
      if (event.kind === 'run.started' || event.kind === 'run.completed') {
        this.refreshRuns();
        this.loadTasks();
      }
    },

    eventKey(event) {
      if (event?.event_uid) return `uid:${event.event_uid}`;
      return Number.isInteger(event?.id) ? `id:${event.id}` : '';
    },

    indexEvent(event) {
      const key = this.eventKey(event);
      if (key) this._eventKeys.add(key);
      if (event.call_id && event.run_id && ['command.completed', 'tool.completed', 'skill.completed'].includes(event.kind)) {
        this._completedKeys.add(`${event.run_id}:${event.call_id}`);
      }
    },

    reindexEvents() {
      this._eventKeys = new Set();
      this._completedKeys = new Set();
      for (const event of this.events) this.indexEvent(event);
    },

    trimEventBuffer() {
      const limit = Math.max(this.EVENT_BUFFER_LIMIT, this.renderWindow + this.RENDER_BATCH);
      if (this.events.length <= limit) return;
      this.events.splice(0, this.events.length - limit);
      this.reindexEvents();
    },

    closeOpenDelta(runId, deltaKinds) {
      // At most one streaming delta of a run is open at any moment, so a
      // backwards scan can stop at the first match.
      for (let index = this.events.length - 1; index >= 0; index -= 1) {
        const candidate = this.events[index];
        if (candidate.run_id !== runId) continue;
        if (deltaKinds.includes(candidate.kind) && !candidate.closed) {
          candidate.closed = true;
        }
        break;
      }
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
      if (event.kind === 'run.started' || event.kind === 'session.started' || event.kind === 'turn.started' || event.kind === 'thinking.completed') {
        return false;
      }
      if (['command.started', 'tool.started', 'skill.started'].includes(event.kind) && this.hasCompletion(event)) {
        return false;
      }
      if (this.selectedProvider !== 'all' && event.provider !== this.selectedProvider) return false;
      return this.selectedWorker === 'all' || event.worker === this.selectedWorker;
    },

    hasCompletion(event) {
      if (!event?.run_id || !event?.call_id) return false;
      return this._completedKeys.has(`${event.run_id}:${event.call_id}`);
    },

    visibleEvents() {
      const total = this.events.length;
      if (total <= this.renderWindow) return this.events;
      return this.events.slice(total - this.renderWindow);
    },

    hasMoreEvents() {
      return this.events.length > this.renderWindow || this._hasServerMore;
    },

    loadMoreEvents() {
      if (this.events.length > this.renderWindow) {
        this.renderWindow = Math.min(this.renderWindow + this.RENDER_BATCH, this.events.length);
        return;
      }
      this.loadOlderFromServer();
    },

    async loadOlderFromServer() {
      if (this._loadingMore || !this._hasServerMore || !this.selectedTaskId) return;
      this._loadingMore = true;
      try {
        const firstId = this.events.find(event => Number.isInteger(event.id))?.id;
        const query = firstId ? `?limit=500&before_id=${firstId}` : '?limit=500';
        const older = await this.request(
          `/audit/tasks/${encodeURIComponent(this.selectedTaskId)}/events${query}`
        );
        if (!older.length) {
          this._hasServerMore = false;
          return;
        }
        const fresh = older.filter(event => {
          const key = this.eventKey(event);
          return !key || !this._eventKeys.has(key);
        });
        this.events = [...fresh, ...this.events];
        this.renderWindow += fresh.length;
        this.reindexEvents();
        if (older.length < 500) this._hasServerMore = false;
      } catch (_) {
        this._hasServerMore = false;
      } finally {
        this._loadingMore = false;
      }
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
      if (this.isShellTool(event)) return '执行';
      const labels = {
        'user.message': '用户',
        'assistant.message': '助手',
        'assistant.delta': '助手',
        'thinking.message': '思考',
        'thinking.delta': '思考',
        'tool.started': event.title || '工具',
        'tool.completed': event.title || '工具结果',
        'command.started': '执行',
        'command.completed': '执行',
        'skill.started': '加载技能',
        'skill.completed': '加载技能',
        'file.changed': '修改',
        'turn.completed': '回合结束',
        'run.completed': '运行结束',
        error: '错误',
        stderr: '标准错误',
      };
      return labels[event.kind] || event.kind;
    },

    isMessage(event) {
      return ['user.message', 'assistant.message', 'assistant.delta'].includes(event.kind);
    },

    isThinking(event) {
      return ['thinking.message', 'thinking.delta'].includes(event.kind);
    },

    isTool(event) {
      return ['tool.started', 'tool.completed', 'file.changed'].includes(event.kind)
        && !this.isShellTool(event)
        && !this.isSkill(event);
    },

    isCommand(event) {
      return ['command.started', 'command.completed'].includes(event.kind) || this.isShellTool(event);
    },

    isSkill(event) {
      const title = String(event?.title || '').trim().toLowerCase().replaceAll('_', ' ');
      return ['skill.started', 'skill.completed'].includes(event.kind)
        || (['tool.started', 'tool.completed'].includes(event.kind)
          && ['skill', 'skills', 'load skill', 'use skill'].includes(title));
    },

    displaySkillName(event) {
      const legacy = String(event?.content || '')
        .match(/(?:launching|loading)\s+skill:\s*([^\s]+)/i)?.[1];
      const name = String(
        event?.skill_name
        || event?.skillName
        || event?.arguments?.skill
        || event?.arguments?.name
        || legacy
        || ''
      ).trim();
      return name.replace(/^redtrace-capabilities:/, '') || '未知技能';
    },

    isShellTool(event) {
      if (!event || !['tool.started', 'tool.completed'].includes(event.kind)) return false;
      const title = String(event.title || '').trim().toLowerCase().replaceAll('_', ' ');
      return ['bash', 'sh', 'shell', 'powershell', 'pwsh', 'cmd', 'command', 'terminal', 'exec'].includes(title)
        || title.includes('shell')
        || title.includes('bash');
    },

    eventCommand(event) {
      if (event?.command) return this.displayCommand(event.command);
      const argumentsValue = event?.arguments;
      if (argumentsValue && typeof argumentsValue === 'object') {
        for (const key of ['command', 'cmd', 'script', 'input']) {
          if (typeof argumentsValue[key] === 'string' && argumentsValue[key].trim()) {
            return this.displayCommand(argumentsValue[key]);
          }
        }
      }
      if (typeof argumentsValue === 'string' && argumentsValue.trim()) {
        return this.displayCommand(argumentsValue);
      }
      if (event?.call_id) {
        const started = this.events.find(candidate =>
          candidate.run_id === event.run_id
          && candidate.call_id === event.call_id
          && ['command.started', 'tool.started'].includes(candidate.kind)
        );
        if (started && started !== event) return this.eventCommand(started);
      }
      return 'shell command';
    },

    displayCommand(value) {
      let text = this.repairMojibake(value).trim();
      const match = text.match(/^\s*["']?.*?[\\/]+(?:pwsh|powershell)(?:\.exe)?["']?\s+-command\s+(.+?)\s*$/is);
      if (!match) return text;
      let command = match[1].trim();
      if (command.length >= 2 && command[0] === command.at(-1) && ['"', "'"].includes(command[0])) {
        command = command.slice(1, -1);
      }
      return command
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\')
        .trim();
    },

    eventStatus(event) {
      if (event?.error) return '失败';
      if (event?.exit_code != null) return `退出码 ${event.exit_code}`;
      return event?.kind?.endsWith('completed') ? '已完成' : '运行中';
    },

    displayText(value) {
      return this.repairMojibake(value || '');
    },

    thinkingKey(event) {
      return String(event?.event_uid || event?.id || '');
    },

    isThinkingOpen(event) {
      return this._openThinking[this.thinkingKey(event)] === true;
    },

    toggleThinking(event) {
      const key = this.thinkingKey(event);
      if (key) this._openThinking[key] = !this._openThinking[key];
    },

    repairMojibake(value) {
      const text = String(value || '');
      if (!/[ÃÂâç¬åæèé]/.test(text) || [...text].some(char => char.charCodeAt(0) > 255)) {
        return text;
      }
      try {
        const bytes = Uint8Array.from([...text], char => char.charCodeAt(0));
        const repaired = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const cjk = value => (value.match(/[\u4e00-\u9fff]/g) || []).length;
        return cjk(repaired) > cjk(text) ? repaired : text;
      } catch (_) {
        return text;
      }
    },

    eventPayload(event) {
      if (event.content) return this.displayText(event.content);
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
