window.pluginsPage = function pluginsPage() {
  const CATEGORIES = [
    { key: 'kernel', label: '内核' },
    { key: 'core', label: '核心' },
    { key: 'feature', label: '功能' },
    { key: 'preset', label: '任务预设' },
    { key: 'user', label: '自定义' },
  ];
  const STATUS_LABELS = {
    running: '运行中',
    pending: '等待依赖',
    stopped: '已停止',
    error: '异常',
  };
  const CATEGORY_LABELS = {
    kernel: '内核',
    core: '核心',
    feature: '功能',
    preset: '任务预设',
    user: '自定义',
  };

  async function pluginRequest(method, path, body) {
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

  return {
    plugins: [],
    loading: false,
    query: '',
    busyId: '',
    uninstallArmedId: '',
    uninstallTimer: null,
    pollTimer: null,
    message: '',
    messageType: 'info',
    addOpen: false,
    addBusy: false,
    addForm: { id: '', label: '', description: '', module: '', config: '' },
    detailId: '',
    detailOpen: false,
    detailTimer: null,

    async init() {
      await this.load();
      this.pollTimer = setInterval(() => {
        if (!document.hidden && !this.addOpen) void this.load();
      }, 5000);
    },

    destroy() {
      clearInterval(this.pollTimer);
      clearTimeout(this.uninstallTimer);
      clearTimeout(this.detailTimer);
    },

    isOn(plugin) {
      return plugin.status === 'running' || plugin.status === 'pending';
    },

    statusLabel(plugin) {
      return STATUS_LABELS[plugin.status] ?? plugin.status;
    },

    categoryLabel(plugin) {
      return CATEGORY_LABELS[plugin.category] ?? plugin.category;
    },

    configPretty(plugin) {
      return JSON.stringify(plugin.config, null, 2);
    },

    get detail() {
      return this.plugins.find((plugin) => plugin.id === this.detailId) ?? null;
    },

    openDetail(plugin) {
      clearTimeout(this.detailTimer);
      this.detailId = plugin.id;
      this.detailOpen = true;
    },

    closeDetail() {
      // Let the leave transition finish before dropping the content.
      this.detailOpen = false;
      this.detailTimer = setTimeout(() => { this.detailId = ''; }, 200);
    },

    async load() {
      this.loading = true;
      try {
        const data = await pluginRequest('GET', '/__redtrace/plugins');
        this.plugins = data.plugins ?? [];
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    get filtered() {
      const needle = this.query.trim().toLowerCase();
      if (!needle) return this.plugins;
      return this.plugins.filter((plugin) =>
        `${plugin.id} ${plugin.label} ${plugin.description} ${plugin.module ?? ''}`
          .toLowerCase()
          .includes(needle),
      );
    },

    get groups() {
      return CATEGORIES
        .map((category) => ({ ...category, items: this.filtered.filter((plugin) => plugin.category === category.key) }))
        .filter((category) => category.items.length > 0);
    },

    get runningCount() {
      return this.plugins.filter((plugin) => this.isOn(plugin)).length;
    },

    countText(group) {
      const running = group.items.filter((plugin) => this.isOn(plugin)).length;
      return `${running}/${group.items.length} 运行`;
    },

    setMessage(text, type = 'info') {
      this.message = text;
      this.messageType = type;
    },

    async toggle(plugin) {
      if (this.busyId || !plugin.canStop) return;
      this.busyId = plugin.id;
      this.setMessage('');
      const action = this.isOn(plugin) ? 'stop' : 'start';
      try {
        await pluginRequest('POST', `/__redtrace/plugins/${encodeURIComponent(plugin.id)}/${action}`);
        await this.load();
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.busyId = '';
      }
    },

    openAdd() {
      this.addForm = { id: '', label: '', description: '', module: '', config: '' };
      this.addOpen = true;
      this.setMessage('');
    },

    closeAdd() {
      this.addOpen = false;
    },

    async add() {
      if (this.addBusy || !this.addForm.id.trim() || !this.addForm.module.trim()) return;
      this.addBusy = true;
      try {
        const body = {
          id: this.addForm.id.trim(),
          module: this.addForm.module.trim(),
        };
        if (this.addForm.label.trim()) body.label = this.addForm.label.trim();
        if (this.addForm.description.trim()) body.description = this.addForm.description.trim();
        if (this.addForm.config.trim()) {
          body.config = JSON.parse(this.addForm.config);
        }
        await pluginRequest('POST', '/__redtrace/plugins', body);
        this.addOpen = false;
        await this.load();
        this.setMessage(`已安装 ${body.id}`, 'success');
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.addBusy = false;
      }
    },

    armUninstall(plugin) {
      if (this.uninstallArmedId && this.uninstallArmedId !== plugin.id) this.resetUninstall();
      this.uninstallArmedId = plugin.id;
      clearTimeout(this.uninstallTimer);
      this.uninstallTimer = setTimeout(() => { this.uninstallArmedId = ''; }, 4000);
    },

    resetUninstall() {
      this.uninstallArmedId = '';
      clearTimeout(this.uninstallTimer);
    },

    async uninstall(plugin) {
      if (this.busyId) return;
      this.busyId = plugin.id;
      this.resetUninstall();
      this.setMessage('');
      try {
        await pluginRequest('DELETE', `/__redtrace/plugins/${encodeURIComponent(plugin.id)}`);
        await this.load();
        this.setMessage(`已卸载 ${plugin.id}`, 'success');
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.busyId = '';
      }
    },
  };
};
