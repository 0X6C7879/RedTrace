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

function displayAgent(agent) {
  return agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Pi';
}

window.skillsPage = function skillsPage() {
  return {
    status: null,
    items: [],
    agents: ['Claude', 'Codex', 'Pi'],
    query: '',
    selectedName: '',
    draft: null,
    isNew: false,
    loading: false,
    saving: false,
    deleteArmed: false,
    deleteTimer: null,
    message: '',

    get enabledCount() {
      return this.items.filter((item) => item.enabled).length;
    },

    get filteredItems() {
      const needle = this.query.trim().toLowerCase();
      if (!needle) return this.items;
      return this.items.filter((item) =>
        `${item.name} ${item.description || ''}`.toLowerCase().includes(needle)
      );
    },

    async init() {
      await this.load();
    },

    async load() {
      this.loading = true;
      this.message = '';
      try {
        const [status, items] = await Promise.all([
          capabilityRequest('GET', '/capabilities'),
          capabilityRequest('GET', '/capabilities/skills'),
        ]);
        this.status = status;
        this.agents = status.agents.map((agent) => displayAgent(agent.id));
        this.items = items;
        if (this.selectedName && items.some((item) => item.name === this.selectedName)) {
          await this.select(this.selectedName);
        } else if (!this.isNew) {
          this.selectedName = '';
          this.draft = null;
        }
      } catch (error) {
        this.message = error.message;
      } finally {
        this.loading = false;
      }
    },

    async select(name) {
      this.isNew = false;
      this.deleteArmed = false;
      this.selectedName = name;
      this.message = '';
      try {
        this.draft = await capabilityRequest('GET', `/capabilities/skills/${encodeURIComponent(name)}`);
      } catch (error) {
        this.message = error.message;
      }
    },

    createNew() {
      this.isNew = true;
      this.selectedName = '';
      this.deleteArmed = false;
      this.message = '';
      this.draft = {
        name: '',
        enabled: true,
        files: [],
        content: '---\nname: skill-name\ndescription: Describe when this skill should be used.\n---\n\n# Skill name\n\nAdd the workflow and any required rules here.\n',
      };
    },

    async save() {
      if (!this.draft || this.saving) return;
      this.saving = true;
      this.message = '';
      try {
        const path = this.isNew
          ? '/capabilities/skills'
          : `/capabilities/skills/${encodeURIComponent(this.draft.name)}`;
        const body = this.isNew
          ? { name: this.draft.name, content: this.draft.content, enabled: this.draft.enabled }
          : { content: this.draft.content, enabled: this.draft.enabled };
        const saved = await capabilityRequest(this.isNew ? 'POST' : 'PUT', path, body);
        this.isNew = false;
        this.selectedName = saved.name;
        this.draft = saved;
        this.message = '已保存，将在下一个 agent 任务中自动同步。';
        await this.refreshList();
      } catch (error) {
        this.message = error.message;
      } finally {
        this.saving = false;
      }
    },

    async refreshList() {
      this.items = await capabilityRequest('GET', '/capabilities/skills');
    },

    armDelete() {
      this.deleteArmed = true;
      clearTimeout(this.deleteTimer);
      this.deleteTimer = setTimeout(() => { this.deleteArmed = false; }, 4000);
    },

    async remove() {
      if (!this.draft || this.isNew) return;
      const name = this.draft.name;
      try {
        await capabilityRequest('DELETE', `/capabilities/skills/${encodeURIComponent(name)}`);
        this.selectedName = '';
        this.draft = null;
        this.deleteArmed = false;
        await this.refreshList();
      } catch (error) {
        this.message = error.message;
      }
    },
  };
};

window.mcpPage = function mcpPage() {
  return {
    status: null,
    items: [],
    agents: ['Claude', 'Codex', 'Pi'],
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

    async init() {
      await this.load();
    },

    async load() {
      this.loading = true;
      this.setMessage('');
      try {
        const [status, items] = await Promise.all([
          capabilityRequest('GET', '/capabilities'),
          capabilityRequest('GET', '/capabilities/mcp'),
        ]);
        this.status = status;
        this.agents = status.agents.map((agent) => displayAgent(agent.id));
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
        this.setMessage('已保存，Claude、Codex、Pi 将在下一个任务中使用新配置。', 'success');
        await this.refreshList();
      } catch (error) {
        this.setMessage(error instanceof SyntaxError ? `JSON 语法错误：${error.message}` : error.message, 'error');
      } finally {
        this.saving = false;
      }
    },

    async refreshList() {
      this.items = await capabilityRequest('GET', '/capabilities/mcp');
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
