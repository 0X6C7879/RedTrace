window.pluginsPage = function pluginsPage() {
  const CATEGORIES = [
    { key: 'kernel', label: '内核' },
    { key: 'core', label: '核心' },
    { key: 'feature', label: '功能' },
    { key: 'preset', label: '角色预设' },
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
    preset: '角色预设',
    user: '自定义',
  };

  return {
    plugins: [],
    loading: false,
    query: '',
    busyId: '',
    uninstallId: '',
    uninstallOpen: false,
    pollTimer: null,
    message: '',
    messageType: 'info',
    addOpen: false,
    addMode: 'custom',
    addBusy: false,
    addForm: { id: '', label: '', description: '', module: '', config: '' },
    detailId: '',
    detailOpen: false,
    detailTimer: null,

    async init() {
      await this.load();
      this.pollTimer = setInterval(() => {
        if (!document.hidden && !this.addOpen && !this.uninstallOpen && !this.busyId) void this.load();
      }, 5000);
    },

    destroy() {
      clearInterval(this.pollTimer);
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
      if (this.loading) return;
      this.loading = true;
      try {
        const data = await capabilityRequest('GET', '/__redtrace/plugins');
        this.plugins = data.plugins ?? [];
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    get available() {
      return this.plugins.filter((plugin) => plugin.source === 'builtin' && plugin.installed === false);
    },

    get filtered() {
      const installed = this.plugins.filter((plugin) => plugin.installed !== false);
      const needle = this.query.trim().toLowerCase();
      if (!needle) return installed;
      return installed.filter((plugin) =>
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

    get pluginCount() {
      return this.plugins.filter((plugin) => plugin.installed !== false && plugin.category !== 'preset').length;
    },

    get runningCount() {
      return this.plugins.filter((plugin) => plugin.installed !== false && plugin.category !== 'preset' && plugin.status === 'running').length;
    },

    countText(group) {
      const running = group.items.filter((plugin) => plugin.status === 'running').length;
      return `${running}/${group.items.length} ${group.key === 'preset' ? '启用' : '运行'}`;
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
        await capabilityRequest('POST', `/__redtrace/plugins/${encodeURIComponent(plugin.id)}/${action}`);
        await this.load();
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.busyId = '';
      }
    },

    openAdd() {
      this.addForm = { id: '', label: '', description: '', module: '', config: '' };
      this.addMode = this.available.length ? 'builtin' : 'custom';
      this.addOpen = true;
      this.setMessage('');
    },

    closeAdd() {
      if (!this.addBusy && !this.busyId) this.addOpen = false;
    },

    async install(plugin) {
      if (this.busyId || this.addBusy || plugin.installed !== false) return;
      this.busyId = plugin.id;
      this.setMessage('');
      try {
        await capabilityRequest('POST', `/__redtrace/plugins/${encodeURIComponent(plugin.id)}/start`);
        await this.load();
        this.setMessage(`已安装 ${plugin.label}`, 'success');
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.busyId = '';
      }
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
        await capabilityRequest('POST', '/__redtrace/plugins', body);
        this.addOpen = false;
        await this.load();
        this.setMessage(`已安装 ${body.id}`, 'success');
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.addBusy = false;
      }
    },

    get uninstallTarget() {
      return this.plugins.find((plugin) => plugin.id === this.uninstallId) ?? null;
    },

    openUninstall(plugin) {
      if (this.busyId || this.loading || !plugin.canUninstall) return;
      this.uninstallId = plugin.id;
      this.uninstallOpen = true;
      this.setMessage('');
    },

    closeUninstall() {
      if (this.busyId) return;
      this.uninstallOpen = false;
      this.uninstallId = '';
    },

    async uninstall(plugin = this.uninstallTarget) {
      if (this.busyId || this.loading || !plugin?.canUninstall) return;
      this.busyId = plugin.id;
      this.setMessage('');
      try {
        await capabilityRequest('DELETE', `/__redtrace/plugins/${encodeURIComponent(plugin.id)}`);
        this.plugins = plugin.source === 'builtin'
          ? this.plugins.map((item) => item.id === plugin.id ? { ...item, installed: false, status: 'stopped', canStop: false, canUninstall: false, error: null } : item)
          : this.plugins.filter((item) => item.id !== plugin.id);
        this.uninstallOpen = false;
        this.uninstallId = '';
        await this.load();
        this.setMessage(`已卸载 ${plugin.label || plugin.id}`, 'success');
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.busyId = '';
      }
    },
  };
};
