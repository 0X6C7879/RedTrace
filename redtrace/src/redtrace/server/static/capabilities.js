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
    versions: [],
    rollbackVersion: '',
    isNew: false,
    loading: false,
    saving: false,
    deleteArmed: false,
    deleteTimer: null,
    message: '',

    get enabledCount() {
      return this.items.filter((item) => item.enabled).length;
    },

    get nestedCount() {
      return this.items.filter((item) => item.nested).length;
    },

    get filteredItems() {
      const needle = this.query.trim().toLowerCase();
      if (!needle) return this.items;
      return this.items.filter((item) =>
        `${item.name} ${item.description || ''} ${item.parent || ''} ${item.path || ''}`
          .toLowerCase()
          .includes(needle)
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
          capabilityRequest('GET', '/capabilities/skill-entries'),
        ]);
        this.status = status;
        this.agents = status.agents.map((agent) => displayAgent(agent.id));
        this.items = items;
        const selected = this.filteredItems.find((item) => item.key === this.selectedName);
        if (selected) {
          await this.select(selected);
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

    async select(item) {
      this.isNew = false;
      this.deleteArmed = false;
      this.selectedName = item.key || item.name;
      this.rollbackVersion = '';
      this.message = '';
      try {
        if (item.nested) {
          const path = item.path.split('/').map(encodeURIComponent).join('/');
          this.draft = await capabilityRequest(
            'GET',
            `/capabilities/skills/${encodeURIComponent(item.parent)}/entries/${path}`,
          );
          this.draft.enabled = this.items.find((parent) => parent.name === item.parent)?.enabled;
          this.versions = [];
          return;
        }
        const name = item.name;
        const [draft, versions] = await Promise.all([
          capabilityRequest('GET', `/capabilities/skills/${encodeURIComponent(name)}`),
          capabilityRequest('GET', `/capabilities/skills/${encodeURIComponent(name)}/versions`),
        ]);
        this.draft = draft;
        this.versions = versions;
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
      this.versions = [];
      this.rollbackVersion = '';
    },

    async save() {
      if (!this.draft || this.draft.nested || this.saving) return;
      this.saving = true;
      this.message = '';
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
        this.message = '已保存，将在下一个 agent 任务中自动同步。';
        await this.refreshList();
      } catch (error) {
        this.message = error.message;
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
      this.message = '';
      try {
        this.draft = await capabilityRequest(
          'POST',
          `/capabilities/skills/${encodeURIComponent(this.draft.name)}/rollback/${version}`,
          { expected_revision: this.draft.revision },
        );
        this.message = `已回滚到 v${version}，并保留完整历史。`;
        await this.load();
      } catch (error) {
        this.message = error.message;
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

window.pluginsPage = function pluginsPage() {
  return {
    status: null,
    items: [],
    agents: ['Claude', 'Codex', 'Pi'],
    query: '',
    selectedId: '',
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
        `${item.id} ${item.name} ${item.kind || ''} ${item.description || ''} ${item.path || ''}`
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
          capabilityRequest('GET', '/capabilities/plugins'),
        ]);
        this.status = status;
        this.agents = status.agents.map((agent) => displayAgent(agent.id));
        this.items = items;
        if (this.selectedId && items.some((item) => item.id === this.selectedId)) {
          await this.select(this.selectedId);
        } else if (!this.isNew) {
          this.selectedId = '';
          this.draft = null;
        }
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    async select(id) {
      this.isNew = false;
      this.deleteArmed = false;
      this.selectedId = id;
      this.setMessage('');
      try {
        const plugin = await capabilityRequest(
          'GET',
          `/capabilities/plugins/${encodeURIComponent(id)}`
        );
        this.draft = {
          id: plugin.id,
          enabled: plugin.enabled,
          ready: plugin.ready,
          agents: plugin.agents || [],
          raw: JSON.stringify(plugin.config, null, 2),
        };
      } catch (error) {
        this.setMessage(error.message, 'error');
      }
    },

    createNew() {
      this.isNew = true;
      this.selectedId = '';
      this.deleteArmed = false;
      this.setMessage('');
      this.draft = {
        id: '',
        enabled: true,
        ready: false,
        agents: ['claude', 'codex', 'pi'],
        raw: JSON.stringify({
          name: 'Plugin name',
          description: 'Describe when Workers should use this plugin.',
          kind: 'external',
          version: '1.0.0',
          path: 'plugins/plugin-name',
          entrypoint: 'plugin.json',
          enabled: true,
          agents: ['claude', 'codex', 'pi'],
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
          throw new Error('插件 JSON 的根值必须是对象。');
        }
        config.enabled = this.draft.enabled;
        config.agents = Array.isArray(config.agents) && config.agents.length
          ? config.agents
          : ['claude', 'codex', 'pi'];
        const path = this.isNew
          ? '/capabilities/plugins'
          : `/capabilities/plugins/${encodeURIComponent(this.draft.id)}`;
        const body = this.isNew ? { id: this.draft.id, config } : { config };
        const saved = await capabilityRequest(this.isNew ? 'POST' : 'PUT', path, body);
        this.isNew = false;
        this.selectedId = saved.id;
        this.draft = {
          id: saved.id,
          enabled: saved.enabled,
          ready: saved.ready,
          agents: saved.agents || [],
          raw: JSON.stringify(saved.config, null, 2),
        };
        this.setMessage('已保存，Claude、Codex、Pi 将在下一个任务快照中使用。', 'success');
        await this.refreshList();
      } catch (error) {
        this.setMessage(
          error instanceof SyntaxError ? `JSON 语法错误：${error.message}` : error.message,
          'error'
        );
      } finally {
        this.saving = false;
      }
    },

    async toggleEnabled() {
      if (!this.draft || this.isNew || this.saving) return;
      this.saving = true;
      this.setMessage('');
      try {
        const saved = await capabilityRequest(
          'PATCH',
          `/capabilities/plugins/${encodeURIComponent(this.draft.id)}/enabled`,
          { enabled: !this.draft.enabled }
        );
        this.draft.enabled = saved.enabled;
        this.draft.raw = JSON.stringify(saved.config, null, 2);
        this.setMessage(saved.enabled ? '插件已启用。' : '插件已停用。', 'success');
        await this.refreshList();
      } catch (error) {
        this.setMessage(error.message, 'error');
      } finally {
        this.saving = false;
      }
    },

    async refreshList() {
      this.items = await capabilityRequest('GET', '/capabilities/plugins');
    },

    armDelete() {
      this.deleteArmed = true;
      clearTimeout(this.deleteTimer);
      this.deleteTimer = setTimeout(() => { this.deleteArmed = false; }, 4000);
    },

    async remove() {
      if (!this.draft || this.isNew) return;
      try {
        await capabilityRequest(
          'DELETE',
          `/capabilities/plugins/${encodeURIComponent(this.draft.id)}`
        );
        this.selectedId = '';
        this.draft = null;
        this.deleteArmed = false;
        this.setMessage('已从全局插件清单移除；插件源目录未删除。', 'success');
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
