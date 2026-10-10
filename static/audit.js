function auditPage() {
  return {
    active: false,
    initialized: false,
    loading: false,
    tasks: [],
    runs: [],
    events: [],
    selectedTaskId: '',
    taskUsage: null,
    selectedProvider: 'all',
    selectedWorker: 'all',
    taskQuery: '',
    autoFollow: true,
    source: null,
    usageTimer: 0,
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
      this.taskUsage = null;
      const results = await Promise.allSettled([
        this.request(`/audit/tasks/${encodeURIComponent(projectId)}/runs`),
        this.request(`/audit/tasks/${encodeURIComponent(projectId)}/events?limit=500`),
        this.request(`/audit/tasks/${encodeURIComponent(projectId)}/usage`),
        this.loadWorkspace(''),
      ]);
      if (results[0].status === 'fulfilled') this.runs = results[0].value;
      if (results[1].status === 'fulfilled') {
        this.events = results[1].value;
        this.reindexEvents();
        if (this.events.length < 500) this._hasServerMore = false;
      }
      if (results[2].status === 'fulfilled') this.taskUsage = results[2].value;
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
        // Live events of one run may arrive out of order; keep each run's
        // session sequence intact while preserving cross-run arrival order.
        pending.sort((a, b) => (
          a.run_id === b.run_id
          && Number.isFinite(a.run_sequence) && Number.isFinite(b.run_sequence)
            ? a.run_sequence - b.run_sequence
            : 0
        ));
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
      // Durable assistant output is where provider usage lands on the run row.
      if (event.kind === 'assistant.message' || event.kind === 'thinking.message') {
        this.scheduleUsageRefresh();
      }
    },

    scheduleUsageRefresh() {
      // Coalesce bursts of assistant messages into one trailing refresh so the
      // counters stay live without a request per streaming step.
      if (this.usageTimer) return;
      this.usageTimer = setTimeout(() => {
        this.usageTimer = 0;
        this.refreshUsage();
      }, 2000);
    },

    async refreshUsage() {
      if (!this.selectedTaskId) return;
      try {
        this.taskUsage = await this.request(
          `/audit/tasks/${encodeURIComponent(this.selectedTaskId)}/usage`
        );
      } catch (_) {}
    },

    formatTokens(value) {
      const n = Number(value) || 0;
      if (n < 1000) return `${n}`;
      if (n < 1000000) {
        const k = n / 1000;
        return `${(k >= 100 ? Math.round(k) : Math.round(k * 10) / 10)}k`;
      }
      return `${Math.round((n / 1000000) * 100) / 100}M`;
    },

    eventKey(event) {
      if (event?.event_uid) return `uid:${event.event_uid}`;
      return Number.isInteger(event?.id) ? `id:${event.id}` : '';
    },

    eventCallId(event) {
      const direct = String(event?.call_id ?? '').trim();
      if (direct) return direct;
      const data = event?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
      for (const key of ['callId', 'toolCallId', 'id']) {
        const value = String(data[key] ?? '').trim();
        if (value) return value;
      }
      return '';
    },

    indexEvent(event) {
      const key = this.eventKey(event);
      if (key) this._eventKeys.add(key);
      const callId = this.eventCallId(event);
      if (callId && event.run_id && ['command.completed', 'tool.completed', 'skill.completed'].includes(event.kind)) {
        this._completedKeys.add(`${event.run_id}:${callId}`);
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
      if (!['system.prompt', 'user.message', 'assistant.message', 'assistant.delta',
        'thinking.message', 'thinking.delta', 'tool.started', 'tool.completed',
        'command.started', 'command.completed', 'skill.started', 'skill.completed',
        'file.changed', 'run.completed', 'error', 'stderr'].includes(event.kind)) return false;
      if (['system.prompt', 'user.message', 'assistant.message', 'assistant.delta', 'thinking.message', 'thinking.delta'].includes(event.kind)
        && !String(event.content || '').trim()) return false;
      if (['command.started', 'tool.started', 'skill.started'].includes(event.kind)) {
        if (this.hasCompletion(event) || this.isRedundantStarted(event)) return false;
      }
      if (this.selectedProvider !== 'all' && this.eventAgent(event) !== this.selectedProvider) return false;
      return this.selectedWorker === 'all' || event.worker === this.selectedWorker;
    },

    hasCompletion(event) {
      const callId = this.eventCallId(event);
      if (!event?.run_id || !callId) return false;
      return this._completedKeys.has(`${event.run_id}:${callId}`);
    },

    isRedundantStarted(event) {
      const startKinds = ['command.started', 'tool.started', 'skill.started'];
      if (!startKinds.includes(event?.kind) || String(event?.call_id ?? '').trim()) return false;
      const callId = this.eventCallId(event);
      if (!event?.run_id || !callId) return false;
      return this.events.some(candidate => (
        candidate !== event
        && candidate.run_id === event.run_id
        && startKinds.includes(candidate.kind)
        && String(candidate.call_id ?? '').trim()
        && this.eventCallId(candidate) === callId
      ));
    },

    visibleEvents() {
      const visible = this.events.filter(event => this.eventVisible(event));
      return visible.length <= this.renderWindow ? visible : visible.slice(-this.renderWindow);
    },

    hasMoreEvents() {
      return this.events.length > this.renderWindow || this._hasServerMore;
    },

    loadMoreOnScroll() {
      const scroller = this.$refs.auditTimeline;
      if (scroller?.scrollTop <= 120) this.loadMoreEvents();
    },

    async loadMoreEvents() {
      if (this._loadingMore || !this.hasMoreEvents() || !this.selectedTaskId) return;
      const scroller = this.$refs.auditTimeline;
      this._loadingMore = true;
      try {
        if (this.events.length > this.renderWindow) {
          const previousHeight = scroller?.scrollHeight || 0;
          const previousTop = scroller?.scrollTop || 0;
          this.renderWindow = Math.min(this.renderWindow + this.RENDER_BATCH, this.events.length);
          await new Promise(resolve => this.$nextTick(resolve));
          if (scroller) scroller.scrollTop = previousTop + scroller.scrollHeight - previousHeight;
        } else {
          // The timeline is session-ordered while ids follow arrival order, so
          // page on the smallest loaded id to never skip an out-of-order row.
          const ids = this.events.map(event => event.id).filter(Number.isInteger);
          const firstId = ids.length ? Math.min(...ids) : undefined;
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
          const previousHeight = scroller?.scrollHeight || 0;
          const previousTop = scroller?.scrollTop || 0;
          this.events = [...fresh, ...this.events];
          this.renderWindow += fresh.length;
          this.reindexEvents();
          if (older.length < 500) this._hasServerMore = false;
          await new Promise(resolve => this.$nextTick(resolve));
          if (scroller) scroller.scrollTop = previousTop + scroller.scrollHeight - previousHeight;
        }
      } catch (_) {
        this._hasServerMore = false;
      } finally {
        this._loadingMore = false;
      }
    },

    providerLabel(provider) {
      return {
        bootstrap: 'Bootstrap',
        reason: 'Reason',
        explore: 'Explore',
        dsh: 'DSH',
        mock: 'Mock',
      }[provider] || provider;
    },

    eventAgent(event) {
      return event.task_type || event.provider || 'dsh';
    },

    providerClass(provider) {
      return `provider-${provider || 'dsh'}`;
    },

    providerDotClass(provider) {
      return `provider-dot-${provider || 'dsh'}`;
    },

    eventAction(event) {
      if (this.isShellTool(event)) return '执行';
      if (this.isSkill(event)) return '加载技能';
      const labels = {
        'user.message': '用户',
        'assistant.message': '助手',
        'assistant.delta': '助手',
        'thinking.message': '思考',
        'thinking.delta': '思考',
        'system.prompt': '系统提示词',
        'tool.started': event.title || '工具',
        'tool.completed': this.toolTitle(event) || '工具结果',
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

    isSystemPrompt(event) {
      return event.kind === 'system.prompt';
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
      // Resolve the title through the paired started event so completions
      // recorded before titles traveled on tool.completed still match.
      const title = String(this.toolTitle(event) || '').trim().toLowerCase().replaceAll('_', ' ');
      return ['skill.started', 'skill.completed'].includes(event.kind)
        || (['tool.started', 'tool.completed'].includes(event.kind)
          && ['skill', 'skills', 'load skill', 'read skill', 'use skill'].includes(title));
    },

    displaySkillName(event) {
      const legacy = String(event?.content || '')
        .match(/(?:launching|loading)\s+skill:\s*([^\s]+)/i)?.[1];
      const args = this.toolArguments(event);
      const name = String(
        event?.skill_name
        || event?.skillName
        || args?.skill
        || args?.name
        || legacy
        || ''
      ).trim();
      return name.replace(/^redtrace-capabilities:/, '') || '未知技能';
    },

    toolArguments(event) {
      if (event?.arguments !== undefined && event?.arguments !== null) {
        return this.parseArguments(event.arguments);
      }
      if (event?.kind !== 'tool.completed' || !event?.call_id) return null;
      const started = this.events.find(candidate =>
        candidate.run_id === event.run_id
        && candidate.call_id === event.call_id
        && candidate.kind === 'tool.started'
      );
      return started ? this.parseArguments(started.arguments) : null;
    },

    isShellTool(event) {
      if (!event || !['tool.started', 'tool.completed'].includes(event.kind)) return false;
      const title = String(this.toolTitle(event)).trim().toLowerCase().replaceAll('_', ' ');
      return ['bash', 'sh', 'shell', 'powershell', 'pwsh', 'cmd', 'command', 'terminal', 'exec'].includes(title)
        || title.includes('shell')
        || title.includes('bash');
    },

    toolTitle(event) {
      if (event?.title) return event.title;
      // Completions recorded before titles traveled on tool.completed can
      // still recover the tool name from their paired tool.started event.
      if (event?.kind !== 'tool.completed' || !event?.call_id) return '';
      const started = this.events.find(candidate =>
        candidate.run_id === event.run_id
        && candidate.call_id === event.call_id
        && candidate.kind === 'tool.started'
      );
      return started?.title || '';
    },

    eventCommand(event) {
      if (event?.command) return this.displayCommand(event.command);
      const argumentsValue = this.parseArguments(event?.arguments);
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

    parseArguments(value) {
      if (typeof value !== 'string' || !value.trim()) return value;
      try { return JSON.parse(value); } catch { return value; }
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
        const parsed = this.parseArguments(event.arguments);
        try { return JSON.stringify(parsed, null, 2); } catch { return String(event.arguments); }
      }
      if (event.changes) {
        try { return JSON.stringify(event.changes, null, 2); } catch {}
      }
      if (['tool.completed', 'command.completed'].includes(event.kind)) return '（未返回可显示的文本输出）';
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
