function operationsPage() {
  return {
    active: false,
    initialized: false,
    loading: false,
    error: '',
    pageMode: 'webshell',
    tab: 'resources',
    resourceKind: 'all',
    query: '',
    resources: [],
    tasks: [],
    audit: [],
    summary: { resources: {}, tasks: {} },
    selectedResourceId: '',
    detail: null,
    terminalOutput: '',
    terminalHistory: [],
    terminalIdentity: { user: 'www-data', host: 'target', cwd: '/var/www/html' },
    command: '',
    workspaceTab: 'terminal',
    terminalSessionId: 'terminal-1',
    terminalSessionName: '终端 1',
    pathInput: '/',
    fileContent: '',
    fileDirectoryPath: '/',
    fileEntries: [],
    fileLoading: false,
    fileMessage: '',
    selectedFilePath: '',
    fileEditorOpen: false,
    fileEditorPath: '',
    fileContextMenu: { open: false, x: 0, y: 0, entry: null },
    fileDialog: { open: false, mode: '', value: '', entry: null },
    databaseType: 'mysql',
    databaseHost: '127.0.0.1',
    databasePort: '3306',
    databaseName: '',
    databaseUser: '',
    databasePassword: '',
    databaseQuery: 'SELECT version();',
    pluginAction: '',
    pluginArguments: '{}',
    runningAction: false,
    resultLoading: false,
    showCreate: false,
    showSecret: false,
    secretOnce: '',
    createBusy: false,
    testBusy: false,
    testMessage: '',
    createError: '',
    createForm: {},
    payloadListenerId: '',
    payloadKind: 'curl_beacon',
    payloadCallback: '',
    payloadOneliner: '',
    payloadOs: 'linux',
    payloadArch: 'amd64',
    payloadBuilding: false,
    builtPayload: null,
    externalPayloadFormat: 'default',
    externalPayloadOptions: '{}',
    externalPayloadBuilding: false,
    pollTimer: null,
    lastProjectId: '',
    kindOptions: [
      { value: 'all', label: '全部资源' },
      { value: 'webshell', label: 'WebShell' },
      { value: 'c2_listener', label: 'C2 Listener' },
      { value: 'c2_session', label: 'C2 Session' },
      { value: 'c2_payload', label: 'C2 Payload' },
      { value: 'c2_profile', label: '流量伪装' },
      { value: 'plugin', label: '插件' },
      { value: 'proxy', label: '代理通道' },
      { value: 'file', label: '文件' },
      { value: 'credential_ref', label: '凭据引用' },
      { value: 'result', label: '任务结果' },
    ],

    init() {
      this.resetCreateForm();
      this.pollTimer = window.setInterval(() => {
        if (this.active && this.projectId()) this.refresh(false);
      }, 3000);
      window.addEventListener('beforeunload', () => window.clearInterval(this.pollTimer), { once: true });
    },

    activePages() {
      return [
        'webshell',
        'c2-listeners',
        'c2-sessions',
        'c2-tasks',
        'c2-payloads',
        'c2-events',
        'c2-profiles',
        'c2-credentials',
      ];
    },

    pageTitle() {
      return {
        webshell: 'WebShell 管理',
        plugins: '插件管理',
        'c2-listeners': '监听器管理',
        'c2-sessions': '会话管理',
        'c2-tasks': 'C2 任务',
        'c2-payloads': 'Payload 生成',
        'c2-events': 'C2 事件',
        'c2-profiles': '流量伪装 / Malleable Profile',
        'c2-credentials': '凭证',
      }[this.pageMode] || 'WebShell 管理';
    },

    pageBadge() {
      return this.pageMode.startsWith('c2-') ? 'C2 · 全局共享' : '全局共享';
    },

    pageDescription() {
      return {
        webshell: '所有任务共享连接；保留来源项目、Intent 与 Worker 标记',
        plugins: '按需发现插件动作；长结果独立存储，不注入模型上下文',
        'c2-listeners': '全局 reverse / bind / Beacon / 外部 C2 Listener，独立于 Worker 生命周期',
        'c2-sessions': '所有任务共享 reverse、bind、SSH、WinRM、PsExec、WMI 与 Beacon 会话',
        'c2-tasks': '跨 Worker 的异步任务队列、审批、取消与结果引用',
        'c2-payloads': '生成单行命令或交叉编译 Beacon；构建结果独立保存',
        'c2-events': '统一查看 C2 Session、任务和人工接管事件',
        'c2-profiles': '配置 User-Agent、Beacon URI、Jitter 和响应头',
        'c2-credentials': '集中保存主机、Web、数据库、云与 Active Directory 凭证',
      }[this.pageMode] || '';
    },

    modeKind() {
      return {
        webshell: 'webshell',
        plugins: 'plugin',
        'c2-listeners': 'c2_listener',
        'c2-sessions': 'c2_session',
        'c2-tasks': 'c2_session',
        'c2-payloads': 'c2_payload',
        'c2-events': 'c2_session',
        'c2-profiles': 'c2_profile',
        'c2-credentials': 'credential_ref',
      }[this.pageMode] || 'webshell';
    },

    defaultCreateKind() {
      return this.modeKind();
    },

    canCreateForPage() {
      return ['webshell', 'plugins', 'c2-listeners', 'c2-profiles', 'c2-credentials'].includes(this.pageMode);
    },

    createButtonLabel() {
      return {
        webshell: '添加连接',
        plugins: '添加插件',
        'c2-listeners': '创建监听器',
        'c2-payloads': '生成 Payload',
        'c2-profiles': '创建 Profile',
        'c2-credentials': '保存凭证',
      }[this.pageMode] || '添加';
    },

    listLabel() {
      return {
        webshell: '连接列表',
        plugins: '插件列表',
        'c2-listeners': '监听器列表',
        'c2-sessions': '会话列表',
        'c2-tasks': '按会话查看任务',
        'c2-payloads': 'Payload 列表',
        'c2-events': '按会话查看事件',
        'c2-profiles': '配置列表',
        'c2-credentials': '凭证列表',
      }[this.pageMode] || '列表';
    },

    projectId() {
      // Operations resources are project-agnostic: when no RedTrace task is
      // active, address the global pool via the ``_global`` sentinel so the
      // list view, summary, audit and single-resource queries stay usable.
      return this.selectedProjectId || '_global';
    },

    isGlobalScope() {
      return !this.selectedProjectId;
    },

    projectName() {
      const project = (this.projects || []).find((item) => item.id === this.projectId());
      return project?.title || project?.name || this.projectId() || '选择项目';
    },

    setActive(active, projectId, pageMode) {
      this.active = Boolean(active);
      if (!this.active) return;
      const pageChanged = pageMode && pageMode !== this.pageMode;
      if (pageMode) this.pageMode = pageMode;
      if (pageChanged) {
        this.selectedResourceId = '';
        this.detail = null;
        this.tab = pageMode === 'c2-events' ? 'audit' : 'resources';
      }
      const scopedProjectId = projectId || '_global';
      if (scopedProjectId !== this.lastProjectId || !this.initialized || pageChanged) {
        this.lastProjectId = scopedProjectId;
        this.refresh(true);
      }
    },

    async api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
          const body = await response.json();
          message = body.detail || message;
        } catch (_) {}
        throw new Error(message);
      }
      if (response.status === 204) return null;
      const contentType = response.headers.get('content-type') || '';
      return contentType.includes('application/json') ? response.json() : response.text();
    },

    async refresh(showLoading = true) {
      const projectId = this.projectId();
      if (!projectId || this.loading) return;
      if (showLoading) this.loading = true;
      this.error = '';
      try {
        const [resourceData, taskData, auditData, summaryData] = await Promise.all([
          this.api(`/projects/${encodeURIComponent(projectId)}/resources?limit=500`),
          this.api(`/projects/${encodeURIComponent(projectId)}/operations/tasks?limit=200`),
          this.api(`/projects/${encodeURIComponent(projectId)}/operations/audit?limit=200`),
          this.api(`/projects/${encodeURIComponent(projectId)}/operations/summary`),
        ]);
        this.resources = resourceData.resources || [];
        if (!this.payloadListenerId) {
          this.payloadListenerId = this.resources.find((item) => item.kind === 'c2_listener')?.id || '';
        }
        this.tasks = taskData.tasks || [];
        this.audit = auditData.events || [];
        this.summary = summaryData;
        if (this.selectedResourceId) {
          const current = this.resources.find((item) => item.id === this.selectedResourceId);
          if (!current) {
            this.selectedResourceId = '';
            this.detail = null;
          } else {
            this.detail = { ...(this.detail || {}), resource: current };
          }
        }
        if (!this.selectedResourceId && this.filteredResources().length) {
          await this.selectResource(this.filteredResources()[0].id);
        }
        this.initialized = true;
      } catch (error) {
        this.error = error.message;
      } finally {
        this.loading = false;
      }
    },

    filteredResources() {
      const needle = this.query.trim().toLowerCase();
      return this.resources.filter((item) => {
        if (item.kind !== this.modeKind()) return false;
        if (!needle) return true;
        return [item.name, item.target, item.summary, item.id]
          .some((value) => String(value || '').toLowerCase().includes(needle));
      });
    },

    async selectResource(id) {
      if (!id || !this.projectId()) return;
      const changed = id !== this.selectedResourceId;
      this.selectedResourceId = id;
      this.resultLoading = true;
      try {
        this.detail = await this.api(
          `/projects/${encodeURIComponent(this.projectId())}/resources/${encodeURIComponent(id)}`
        );
        const resource = this.detail.resource;
        this.pluginAction = resource.kind === 'plugin' ? (resource.metadata?.actions?.[0] || '') : '';
        const latest = (this.detail.tasks || []).find((task) => task.output_summary);
        if (resource.kind === 'webshell' && changed) this.resetWebshellWorkspace(resource);
        if (resource.kind === 'c2_session' && changed) {
          this.terminalIdentity = {
            user: resource.metadata?.username || 'shell',
            host: resource.metadata?.hostname || resource.target || 'target',
            cwd: resource.metadata?.cwd || (String(resource.metadata?.os || '').toLowerCase() === 'windows' ? 'C:\\' : '/'),
          };
          this.terminalHistory = [];
        }
        if (resource.kind !== 'webshell' && latest) this.terminalOutput = latest.output_summary;
      } catch (error) {
        this.error = error.message;
      } finally {
        this.resultLoading = false;
      }
    },

    currentResource() {
      return this.detail?.resource || this.resources.find((item) => item.id === this.selectedResourceId) || null;
    },

    webshellUsable() {
      const resource = this.currentResource();
      return resource?.kind === 'webshell' && resource.status === 'available';
    },

    webshellSessionLabel() {
      if (this.runningAction) return '命令执行中';
      return this.webshellUsable()
        ? '会话可用'
        : `会话${this.statusLabel(this.currentResource()?.status || 'offline')}`;
    },

    resetWebshellWorkspace(resource) {
      let host = 'target';
      try {
        host = new URL(resource.target).hostname || host;
      } catch (_) {
        host = String(resource.target || '').split(/[/:]/).filter(Boolean)[0] || host;
      }
      const windows = String(resource.metadata?.os || '').toLowerCase() === 'windows';
      this.terminalIdentity = {
        user: resource.metadata?.username || (windows ? 'iis apppool' : 'www-data'),
        host: resource.metadata?.hostname || host,
        cwd: resource.metadata?.cwd || (windows ? 'C:\\inetpub\\wwwroot' : '/var/www/html'),
      };
      this.terminalHistory = [];
      this.workspaceTab = 'terminal';
      this.fileDirectoryPath = resource.metadata?.cwd || (windows ? 'C:\\inetpub\\wwwroot' : '/var/www/html');
      this.pathInput = this.fileDirectoryPath;
      this.fileEntries = [];
      this.fileMessage = '';
      this.fileEditorOpen = false;
      this.selectedFilePath = '';
      this.closeFileContextMenu();
    },

    terminalPrompt() {
      const { user, cwd } = this.terminalIdentity;
      return `(${user}:${cwd}) $`;
    },

    tasksForCurrent() {
      if (this.pageMode === 'c2-tasks') {
        const sessionIds = new Set(this.resources.filter((item) => item.kind === 'c2_session').map((item) => item.id));
        return this.tasks.filter((task) => sessionIds.has(task.resource_id));
      }
      if (!this.selectedResourceId) return [];
      return this.tasks.filter((task) => task.resource_id === this.selectedResourceId);
    },

    visibleAudit() {
      if (this.pageMode === 'c2-events') {
        const c2Ids = new Set(
          this.resources
            .filter((item) => ['c2_listener', 'c2_session', 'c2_payload', 'c2_profile'].includes(item.kind))
            .map((item) => item.id)
        );
        return this.audit.filter((item) => !item.resource_id || c2Ids.has(item.resource_id));
      }
      if (!this.selectedResourceId) return this.audit;
      return this.audit.filter((item) => item.resource_id === this.selectedResourceId);
    },

    pendingApprovals() {
      return this.tasks.filter((task) => task.status === 'awaiting_approval').length;
    },

    activeTasks() {
      return this.tasks.filter((task) => ['queued', 'running', 'awaiting_approval'].includes(task.status)).length;
    },

    availableResources() {
      return this.filteredResources().filter((item) => item.status === 'available').length;
    },

    kindLabel(kind) {
      return this.kindOptions.find((item) => item.value === kind)?.label || kind;
    },

    statusLabel(status) {
      return {
        available: '可用',
        degraded: '异常',
        offline: '离线',
        retired: '已归档',
        queued: '等待执行',
        running: '执行中',
        awaiting_approval: '待审批',
        succeeded: '成功',
        failed: '失败',
        cancelled: '已取消',
        rejected: '已拒绝',
      }[status] || status;
    },

    statusClass(status) {
      return `ops-status-${String(status || 'offline').replaceAll('_', '-')}`;
    },

    relativeTime(value) {
      if (!value) return '—';
      const date = new Date(value);
      const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
      if (seconds < 60) return `${seconds} 秒前`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
      return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },

    actorName() {
      return 'admin';
    },

    resetCreateForm(kind = 'webshell') {
      this.createForm = {
        kind,
        name: '',
        target: '',
        summary: '',
        status: 'available',
        commandParam: 'cmd',
        passwordParam: '',
        password: '',
        shellType: 'php',
        protocol: 'auto',
        targetOs: 'auto',
        encoding: 'auto',
        method: 'POST',
        verifyTls: false,
        listenerType: 'http_beacon',
        bindHost: '127.0.0.1',
        bindPort: '8443',
        callbackHost: '',
        targetHost: '',
        profileId: '',
        profileName: '',
        userAgent: '',
        beaconUris: '/api/v1/status',
        jitterMin: 100,
        jitterMax: 500,
        responseHeaders: '{"Server":"nginx"}',
        endpoint: '',
        token: '',
        actions: '',
        metadataJson: '{}',
        parentResourceId: '',
        publishFact: true,
        credentialType: 'host',
        credentialUsername: '',
        credentialDomain: '',
        credentialSecret: '',
      };
      this.createError = '';
      this.testMessage = '';
      this.secretOnce = '';
    },

    openCreate(kind = 'webshell') {
      this.resetCreateForm(kind);
      this.showCreate = true;
    },

    async createResource() {
      if (!this.projectId()) return;
      if (this.createForm.kind === 'webshell' && !this.createForm.name.trim()) {
        this.createForm.name = this.createForm.target.trim();
      }
      if (this.createForm.kind === 'c2_listener' && !this.createForm.name.trim()) {
        this.createForm.name = `${this.createForm.listenerType}-${this.createForm.bindPort}`;
      }
      if (this.createForm.kind === 'c2_profile' && !this.createForm.name.trim()) {
        this.createForm.name = this.createForm.profileName.trim();
      }
      if (!this.createForm.name.trim()) return;
      this.createBusy = true;
      this.createError = '';
      const form = this.createForm;
      const metadata = {};
      const secret = {};
      if (form.kind === 'webshell') {
        metadata.command_param = form.commandParam || 'cmd';
        metadata.password_param = form.passwordParam || '';
        metadata.shell_type = form.shellType;
        metadata.protocol = form.protocol;
        metadata.os = form.targetOs;
        metadata.encoding = form.encoding;
        metadata.method = form.method;
        metadata.verify_tls = Boolean(form.verifyTls);
        if (form.password) secret.password = form.password;
      }
      if (form.kind === 'c2_listener') {
        metadata.listener_type = form.listenerType;
        metadata.bind_host = form.bindHost || '127.0.0.1';
        metadata.bind_port = Number(form.bindPort || 0);
        metadata.callback_host = form.callbackHost || '';
        metadata.target_host = form.targetHost || '';
        metadata.profile_id = form.profileId || '';
        if (['msf', 'sliver', 'cobalt_strike', 'custom'].includes(form.listenerType)) {
          metadata.adapter_endpoint = form.endpoint || '';
          if (form.endpoint) secret.adapter_endpoint = form.endpoint;
          if (form.token) secret.token = form.token;
        }
        form.target = `${metadata.bind_host}:${metadata.bind_port}`;
        form.status = 'available';
      }
      if (form.kind === 'plugin') {
        metadata.actions = form.actions.split(',').map((value) => value.trim()).filter(Boolean);
        if (form.endpoint) secret.endpoint = form.endpoint;
        if (form.token) secret.token = form.token;
      }
      if (form.kind === 'c2_profile') {
        metadata.user_agent = form.userAgent || '';
        metadata.beacon_uris = String(form.beaconUris || '').split('\n').map((item) => item.trim()).filter(Boolean);
        metadata.jitter_min_ms = Number(form.jitterMin || 0);
        metadata.jitter_max_ms = Number(form.jitterMax || 0);
        try {
          metadata.response_headers = JSON.parse(form.responseHeaders || '{}');
        } catch (_) {
          this.createError = '响应头必须是有效 JSON';
          this.createBusy = false;
          return;
        }
        form.name = form.profileName || form.name;
        form.target = `profile://${form.name}`;
      }
      if (form.kind === 'credential_ref') {
        metadata.credential_type = form.credentialType;
        metadata.username = form.credentialUsername || '';
        metadata.domain = form.credentialDomain || '';
        if (form.credentialSecret) secret.value = form.credentialSecret;
      }
      try {
        const data = await this.api(`/projects/${encodeURIComponent(this.projectId())}/resources`, {
          method: 'POST',
          body: JSON.stringify({
            kind: form.kind,
            name: form.name.trim(),
            target: form.target.trim(),
            summary: form.summary.trim(),
            status: form.status,
            metadata,
            secret,
            parent_resource_id: form.parentResourceId || null,
            actor_type: 'human',
            actor: this.actorName(),
            publish_fact: Boolean(form.publishFact),
          }),
        });
        this.secretOnce = data.secret_once || '';
        this.showCreate = false;
        this.showSecret = Boolean(this.secretOnce);
        await this.refresh(false);
        await this.selectResource(data.resource.id);
      } catch (error) {
        this.createError = error.message;
      } finally {
        this.createBusy = false;
      }
    },

    async createTask(action, arguments = {}, risk = 'low', requiresApproval = false, options = {}) {
      const resource = this.currentResource();
      if (!resource || this.runningAction) return null;
      // Operation tasks must keep a project provenance (audit trail). Ask the
      // operator to attach a task when none is selected instead of silently
      // falling back to a phantom project.
      if (this.isGlobalScope()) {
        const message = '请先在「工作台」中选择一个 RedTrace 任务用于记录本次操作';
        this.error = message;
        if (!options.silent) this.terminalOutput = `操作失败：${message}`;
        return null;
      }
      this.runningAction = true;
      this.error = '';
      try {
        const data = await this.api(
          `/projects/${encodeURIComponent(this.projectId())}/resources/${encodeURIComponent(resource.id)}/tasks`,
          {
            method: 'POST',
            body: JSON.stringify({
              action,
              arguments,
              actor_type: 'human',
              actor: this.actorName(),
              risk,
              requires_approval: requiresApproval,
            }),
          }
        );
        if (!options.silent) {
          this.terminalOutput = `任务 ${data.task.id} 已${data.task.status === 'awaiting_approval' ? '提交审批' : '进入队列'}。`;
        }
        await this.refresh(false);
        if (!options.silent) await this.selectResource(resource.id);
        return data.task;
      } catch (error) {
        this.error = error.message;
        if (!options.silent) this.terminalOutput = `操作失败：${error.message}`;
        return null;
      } finally {
        this.runningAction = false;
      }
    },

    async waitForTask(taskId, timeoutMs = 65000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const data = await this.api(
          `/projects/${encodeURIComponent(this.projectId())}/operations/tasks/${encodeURIComponent(taskId)}`
        );
        const task = data.task;
        if (task && ['succeeded', 'failed', 'cancelled', 'rejected'].includes(task.status)) return task;
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
      throw new Error('任务仍在后台执行，可在“任务”页继续查看');
    },

    async runCommand() {
      const value = this.command.trim();
      const resource = this.currentResource();
      const usableShell = resource?.status === 'available' && ['webshell', 'c2_session'].includes(resource.kind);
      if (!value || !usableShell) return;
      this.command = '';
      const record = {
        id: `${Date.now()}-${this.terminalHistory.length}`,
        prompt: this.terminalPrompt(),
        user: this.terminalIdentity.user,
        cwd: this.terminalIdentity.cwd,
        command: value,
        output: '正在执行…',
        failed: false,
      };
      const recordIndex = this.terminalHistory.length;
      this.terminalHistory.push(record);
      const queued = await this.createTask(
        'command',
        { command: resource.kind === 'webshell' ? this.terminalExecutionCommand(value) : value },
        'medium',
        false,
        { silent: true }
      );
      if (!queued || queued.status === 'awaiting_approval') return;
      this.runningAction = true;
      try {
        const completed = await this.waitForTask(queued.id);
        let output = completed.output_summary || this.statusLabel(completed.status);
        if (completed.result_ref) output = await this.api(completed.result_ref, { headers: {} });
        const renderedOutput = String(output || '').replace(/\s+$/, '');
        this.terminalOutput = renderedOutput;
        this.terminalHistory[recordIndex] = {
          ...this.terminalHistory[recordIndex],
          output: renderedOutput,
          failed: completed.status !== 'succeeded',
        };
        this.updateTerminalContext(value, renderedOutput);
        await this.refresh(false);
      } catch (error) {
        this.terminalHistory[recordIndex] = {
          ...this.terminalHistory[recordIndex],
          output: error.message,
          failed: true,
        };
      } finally {
        this.runningAction = false;
      }
    },

    terminalExecutionCommand(value) {
      const windows = String(this.currentResource()?.metadata?.os || '').toLowerCase() === 'windows';
      const cwd = this.terminalIdentity.cwd;
      const cdMatch = value.match(/^cd(?:\s+(.+))?$/i);
      if (windows) {
        const prefix = `cd /d "${String(cwd).replaceAll('"', '""')}"`;
        return cdMatch
          ? `${prefix} && cd /d ${cdMatch[1] || 'C:\\'} && cd`
          : `${prefix} && ${value}`;
      }
      const quotedCwd = `'${String(cwd).replaceAll("'", "'\\''")}'`;
      return cdMatch
        ? `cd ${quotedCwd} && cd ${cdMatch[1] || '/'} && pwd`
        : `cd ${quotedCwd} && ${value}`;
    },

    updateTerminalContext(command, output) {
      const firstLine = String(output || '').split(/\r?\n/).find((line) => line.trim())?.trim();
      if (!firstLine) return;
      if (/^whoami$/i.test(command)) this.terminalIdentity.user = firstLine;
      if (/^hostname$/i.test(command)) this.terminalIdentity.host = firstLine;
      if (/^pwd$/i.test(command) || /^cd(?:\s|$)/i.test(command)) this.terminalIdentity.cwd = firstLine;
    },

    async runQuickCommand(command) {
      if (this.runningAction || !this.webshellUsable()) return;
      this.command = command;
      await this.runCommand();
    },

    clearTerminal() {
      this.terminalHistory = [];
    },

    async copyTerminal() {
      const log = this.terminalHistory
        .map((item) => `${item.prompt} ${item.command}\n${item.output}`)
        .join('\n');
      await navigator.clipboard.writeText(`${log}${log ? '\n' : ''}${this.terminalPrompt()} `);
    },

    setWorkspaceTab(tab) {
      this.workspaceTab = tab;
      this.closeFileContextMenu();
      if (tab === 'files' && !this.fileEntries.length) this.loadDirectory(this.fileDirectoryPath);
    },

    encodeBase64(value) {
      const bytes = new TextEncoder().encode(value);
      let binary = '';
      bytes.forEach((value) => { binary += String.fromCharCode(value); });
      return btoa(binary);
    },

    decodeBase64(value) {
      const binary = atob(String(value || '').replace(/\s/g, ''));
      return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
    },

    async runFileTask(action, arguments, risk = 'low', requiresApproval = false) {
      const queued = await this.createTask(action, arguments, risk, requiresApproval, { silent: true });
      if (!queued) return null;
      if (queued.status === 'awaiting_approval') {
        this.fileMessage = '删除任务已提交审批；批准后会在后台执行。';
        return null;
      }
      const completed = await this.waitForTask(queued.id);
      if (completed.status !== 'succeeded') {
        throw new Error(completed.output_summary || this.statusLabel(completed.status));
      }
      if (!completed.result_ref) return '';
      return this.api(completed.result_ref, { headers: {} });
    },

    parseFileListing(output) {
      return String(output || '')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [kind, name, modified, size, permissions] = line.split('\t');
          if (!name || !['d', 'f', 'l'].includes(kind)) return null;
          return {
            kind,
            name,
            modified: modified || '—',
            size: Number(size || 0),
            permissions: permissions || '—',
            path: this.joinPath(this.fileDirectoryPath, name),
          };
        })
        .filter(Boolean)
        .sort((left, right) => {
          if (left.kind !== right.kind) return left.kind === 'd' ? -1 : 1;
          return left.name.localeCompare(right.name, 'zh-CN', { numeric: true });
        });
    },

    async loadDirectory(path = this.fileDirectoryPath) {
      const nextPath = String(path || '').trim();
      if (!nextPath || this.fileLoading) return;
      this.fileLoading = true;
      this.fileMessage = '正在读取目录…';
      this.fileEditorOpen = false;
      this.closeFileContextMenu();
      try {
        const output = await this.runFileTask('list_files', { path: nextPath });
        if (output === null) return;
        this.fileDirectoryPath = nextPath;
        this.pathInput = nextPath;
        this.fileEntries = this.parseFileListing(output);
        this.selectedFilePath = '';
        this.fileMessage = this.fileEntries.length ? '' : '当前目录为空';
      } catch (error) {
        this.fileMessage = `目录读取失败：${error.message}`;
      } finally {
        this.fileLoading = false;
      }
    },

    joinPath(directory, name) {
      const windows = /\\/.test(directory) || /^[A-Za-z]:/.test(directory);
      const separator = windows ? '\\' : '/';
      const base = String(directory || separator).replace(/[\\/]+$/, '');
      return `${base || separator}${base ? separator : ''}${name}`.replace(windows ? /\\{2,}/g : /\/{2,}/g, separator);
    },

    parentPath(path = this.fileDirectoryPath) {
      const windows = /\\/.test(path) || /^[A-Za-z]:/.test(path);
      const separator = windows ? '\\' : '/';
      const value = String(path || separator).replace(/[\\/]+$/, '');
      if (!value || value === '/' || /^[A-Za-z]:$/.test(value)) return windows ? `${value}\\` : '/';
      const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
      if (index <= 0) return windows ? value.slice(0, 2) + '\\' : '/';
      return value.slice(0, index);
    },

    fileTreeNodes() {
      const path = this.fileDirectoryPath;
      const windows = /\\/.test(path) || /^[A-Za-z]:/.test(path);
      const separator = windows ? '\\' : '/';
      const parts = path.split(/[\\/]/).filter(Boolean);
      const nodes = [];
      let current = windows && parts[0]?.endsWith(':') ? parts.shift() + '\\' : '/';
      nodes.push({ name: current, path: current });
      parts.forEach((part) => {
        current = this.joinPath(current, part);
        nodes.push({ name: part, path: current });
      });
      return nodes;
    },

    async openFileEntry(entry) {
      this.selectedFilePath = entry.path;
      this.closeFileContextMenu();
      if (entry.kind === 'd') {
        await this.loadDirectory(entry.path);
      } else {
        await this.readFileEntry(entry);
      }
    },

    async readFileEntry(entry) {
      this.fileLoading = true;
      this.fileMessage = `正在读取 ${entry.name}…`;
      try {
        const output = await this.runFileTask('read_file', { path: entry.path });
        if (output === null) return;
        this.fileContent = this.decodeBase64(output);
        this.fileEditorPath = entry.path;
        this.pathInput = entry.path;
        this.fileEditorOpen = true;
        this.fileMessage = '';
      } catch (error) {
        this.fileMessage = `文件读取失败：${error.message}`;
      } finally {
        this.fileLoading = false;
      }
    },

    async saveCurrentFile() {
      if (!this.fileEditorPath || this.fileLoading) return;
      this.fileLoading = true;
      try {
        await this.runFileTask('write_file', {
          path: this.fileEditorPath,
          content_base64: this.encodeBase64(this.fileContent || ''),
        }, 'medium');
        this.fileMessage = '文件已保存';
        this.fileLoading = false;
        await this.loadDirectory(this.fileDirectoryPath);
      } catch (error) {
        this.fileMessage = `保存失败：${error.message}`;
      } finally {
        this.fileLoading = false;
      }
    },

    showFileContextMenu(event, entry) {
      event.preventDefault();
      this.selectedFilePath = entry.path;
      this.fileContextMenu = {
        open: true,
        x: Math.min(event.clientX, window.innerWidth - 190),
        y: Math.min(event.clientY, window.innerHeight - 260),
        entry,
      };
    },

    closeFileContextMenu() {
      this.fileContextMenu = { open: false, x: 0, y: 0, entry: null };
    },

    beginFileDialog(mode, entry = null) {
      this.closeFileContextMenu();
      this.fileDialog = {
        open: true,
        mode,
        entry,
        value: mode === 'rename' ? (entry?.name || '') : '',
      };
    },

    fileDialogTitle() {
      return { folder: '新建文件夹', file: '新建文件', rename: '重命名' }[this.fileDialog.mode] || '文件操作';
    },

    async confirmFileDialog() {
      const value = this.fileDialog.value.trim();
      if (!value || this.fileLoading) return;
      const { mode, entry } = this.fileDialog;
      this.fileDialog.open = false;
      try {
        if (mode === 'rename') {
          await this.runFileTask('move_file', {
            path: entry.path,
            destination: this.joinPath(this.fileDirectoryPath, value),
          }, 'medium');
        } else {
          await this.runFileTask(mode === 'folder' ? 'create_directory' : 'create_file', {
            path: this.joinPath(this.fileDirectoryPath, value),
          });
        }
        this.fileMessage = '操作已完成';
        await this.loadDirectory(this.fileDirectoryPath);
      } catch (error) {
        this.fileMessage = `操作失败：${error.message}`;
      }
    },

    async deleteFileEntry(entry) {
      this.closeFileContextMenu();
      await this.runFileTask('delete_file', { path: entry.path }, 'high', true);
    },

    async downloadFile(entry) {
      this.closeFileContextMenu();
      try {
        const output = await this.runFileTask('read_file', { path: entry.path });
        if (output === null) return;
        const bytes = Uint8Array.from(atob(String(output).replace(/\s/g, '')), (character) => character.charCodeAt(0));
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([bytes]));
        link.download = entry.name;
        link.click();
        URL.revokeObjectURL(link.href);
      } catch (error) {
        this.fileMessage = `下载失败：${error.message}`;
      }
    },

    async uploadFile(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        buffer.forEach((value) => { binary += String.fromCharCode(value); });
        await this.runFileTask('write_file', {
          path: this.joinPath(this.fileDirectoryPath, file.name),
          content_base64: btoa(binary),
        }, 'medium');
        this.fileMessage = `${file.name} 已上传`;
        await this.loadDirectory(this.fileDirectoryPath);
      } catch (error) {
        this.fileMessage = `上传失败：${error.message}`;
      }
    },

    openDirectoryInTerminal(path = this.fileDirectoryPath) {
      this.terminalIdentity.cwd = path;
      this.workspaceTab = 'terminal';
      this.closeFileContextMenu();
    },

    formatFileSize(bytes) {
      const value = Number(bytes || 0);
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    },

    async runDatabaseQuery() {
      const query = String(this.databaseQuery || '').trim();
      if (!query) return;
      let command = '';
      if (this.databaseType === 'sqlite') {
        if (!this.databaseName.trim()) {
          this.error = 'SQLite 查询需要填写数据库文件路径';
          return;
        }
        command = `sqlite3 ${JSON.stringify(this.databaseName.trim())} ${JSON.stringify(query)}`;
      } else if (this.databaseType === 'postgresql') {
        command = `psql -h ${JSON.stringify(this.databaseHost)} -p ${Number(this.databasePort || 5432)} ${this.databaseName ? `-d ${JSON.stringify(this.databaseName)}` : ''} -c ${JSON.stringify(query)}`;
      } else {
        command = `mysql -h ${JSON.stringify(this.databaseHost)} -P ${Number(this.databasePort || 3306)} ${this.databaseName ? JSON.stringify(this.databaseName) : ''} -e ${JSON.stringify(query)}`;
      }
      await this.runQuickCommand(command.trim());
    },

    async testWebshellForm() {
      const form = this.createForm;
      if (!this.projectId() || !String(form.target || '').trim()) {
        this.testMessage = '请先填写 Shell 地址';
        return;
      }
      this.testBusy = true;
      this.testMessage = '正在测试连接…';
      try {
        const data = await this.api(`/projects/${encodeURIComponent(this.projectId())}/webshell/test`, {
          method: 'POST',
          body: JSON.stringify({
            target: form.target.trim(),
            password: form.password || '',
            shell_type: form.shellType,
            protocol: form.protocol,
            method: form.method,
            command_param: form.commandParam || '',
            password_param: form.passwordParam || '',
            target_os: form.targetOs,
            encoding: form.encoding,
            verify_tls: Boolean(form.verifyTls),
          }),
        });
        this.testMessage = `连接成功：${data.summary || '探测通过'}`;
      } catch (error) {
        this.testMessage = error.message;
      } finally {
        this.testBusy = false;
      }
    },

    async batchProbe() {
      const webshells = this.resources.filter((item) => item.kind === 'webshell');
      for (const item of webshells) {
        this.selectedResourceId = item.id;
        await this.selectResource(item.id);
        const task = await this.createTask('probe', {}, 'low', false);
        if (task) {
          try { await this.waitForTask(task.id, 25000); } catch (_) {}
        }
      }
      await this.refresh(false);
    },

    c2Listeners() {
      return this.resources.filter((item) => item.kind === 'c2_listener');
    },

    c2Profiles() {
      return this.resources.filter((item) => item.kind === 'c2_profile');
    },

    async generateOneliner() {
      if (!this.payloadListenerId) {
        this.error = '请先选择监听器';
        return;
      }
      try {
        const data = await this.api(`/projects/${encodeURIComponent(this.projectId())}/c2/payloads/oneliner`, {
          method: 'POST',
          body: JSON.stringify({
            listener_id: this.payloadListenerId,
            kind: this.payloadKind,
            callback_host: this.payloadCallback || '',
          }),
        });
        this.payloadOneliner = data.oneliner;
      } catch (error) {
        this.error = error.message;
      }
    },

    async buildBeacon() {
      if (!this.payloadListenerId || this.payloadBuilding) return;
      this.payloadBuilding = true;
      this.builtPayload = null;
      try {
        const callbackUrl = this.payloadCallback && this.payloadCallback.includes('://') ? this.payloadCallback : '';
        const data = await this.api(`/projects/${encodeURIComponent(this.projectId())}/c2/payloads/build`, {
          method: 'POST',
          body: JSON.stringify({
            listener_id: this.payloadListenerId,
            callback_url: callbackUrl,
            os: this.payloadOs,
            arch: this.payloadArch,
            actor: this.actorName(),
          }),
        });
        this.builtPayload = data.payload;
        await this.refresh(false);
      } catch (error) {
        this.error = error.message;
      } finally {
        this.payloadBuilding = false;
      }
    },

    async buildExternalPayload() {
      if (!this.payloadListenerId || this.externalPayloadBuilding) return;
      let options = {};
      try { options = JSON.parse(this.externalPayloadOptions || '{}'); }
      catch (_) { this.error = '外部 Payload 参数必须是有效 JSON'; return; }
      this.externalPayloadBuilding = true;
      this.builtPayload = null;
      try {
        const data = await this.api(`/projects/${encodeURIComponent(this.projectId())}/c2/payloads/external`, {
          method: 'POST',
          body: JSON.stringify({
            listener_id: this.payloadListenerId,
            format: this.externalPayloadFormat || 'default',
            options,
            actor: this.actorName(),
          }),
        });
        this.builtPayload = data.payload;
        await this.refresh(false);
      } catch (error) { this.error = error.message; }
      finally { this.externalPayloadBuilding = false; }
    },

    async runPlugin() {
      if (!this.pluginAction.trim()) return;
      let argumentsValue = {};
      try {
        argumentsValue = JSON.parse(this.pluginArguments || '{}');
      } catch (_) {
        this.error = '插件参数必须是有效 JSON';
        return;
      }
      await this.createTask(this.pluginAction.trim(), argumentsValue, 'medium', false);
    },

    async loadResult(task) {
      if (!task?.result_ref || this.resultLoading) return;
      this.resultLoading = true;
      try {
        this.terminalOutput = await this.api(task.result_ref, { headers: {} });
      } catch (error) {
        this.error = error.message;
      } finally {
        this.resultLoading = false;
      }
    },

    async decideTask(task, decision) {
      await this.api(
        `/projects/${encodeURIComponent(this.projectId())}/operations/tasks/${encodeURIComponent(task.id)}/approval`,
        {
          method: 'POST',
          body: JSON.stringify({ actor: this.actorName(), decision }),
        }
      );
      await this.refresh(false);
      if (this.selectedResourceId) await this.selectResource(this.selectedResourceId);
    },

    async cancelTask(task) {
      await this.api(
        `/projects/${encodeURIComponent(this.projectId())}/operations/tasks/${encodeURIComponent(task.id)}/cancel`,
        {
          method: 'POST',
          body: JSON.stringify({ actor: this.actorName(), reason: '人工取消' }),
        }
      );
      await this.refresh(false);
    },

    async toggleLock() {
      const resource = this.currentResource();
      if (!resource) return;
      const action = resource.locked ? 'unlock' : 'lock';
      const data = await this.api(
        `/projects/${encodeURIComponent(this.projectId())}/resources/${encodeURIComponent(resource.id)}/${action}`,
        {
          method: 'POST',
          body: JSON.stringify({ actor_type: 'human', actor: this.actorName() }),
        }
      );
      this.detail.resource = data.resource;
      await this.refresh(false);
    },

    async toggleWorkerPause() {
      const resource = this.currentResource();
      if (!resource) return;
      const data = await this.api(
        `/projects/${encodeURIComponent(this.projectId())}/resources/${encodeURIComponent(resource.id)}/worker-control`,
        {
          method: 'POST',
          body: JSON.stringify({ paused: !resource.worker_paused, actor: this.actorName() }),
        }
      );
      this.detail.resource = data.resource;
      await this.refresh(false);
    },

    async setState(status) {
      const resource = this.currentResource();
      if (!resource) return;
      const data = await this.api(
        `/projects/${encodeURIComponent(this.projectId())}/resources/${encodeURIComponent(resource.id)}/state`,
        {
          method: 'POST',
          body: JSON.stringify({ status, actor: this.actorName() }),
        }
      );
      this.detail.resource = data.resource;
      await this.refresh(false);
    },

    async removeResource() {
      const resource = this.currentResource();
      if (!resource || !window.confirm(`删除共享资源“${resource.name}”？`)) return;
      await this.api(
        `/projects/${encodeURIComponent(this.projectId())}/resources/${encodeURIComponent(resource.id)}?actor=${encodeURIComponent(this.actorName())}`,
        { method: 'DELETE' }
      );
      this.selectedResourceId = '';
      this.detail = null;
      await this.refresh(false);
    },

    async copySecret() {
      if (!this.secretOnce) return;
      await navigator.clipboard.writeText(this.secretOnce);
    },
  };
}
