/* The canvas consumes the server's FGS projection. Execution stays in the Steps panel. */
window.redtraceFgsView = {
  fgsFocusGoal: '',
  fgsPanelOpen: false,
  fgsEdgeSelection: null,
  fgsStepFilter: '',
  fgsRuns: [],
  fgsRunId: '',
  fgsRunEvents: [],
  fgsRunHasMore: false,
  async openIntentLog(stepId) {
    if (this.replay.active) return;
    try {
      this.fgsRuns = await this.api('GET', `/v2/projects/${this.selectedProjectId}/steps/${stepId}/runs`);
      this.fgsRunId = this.fgsRuns.at(-1)?.id || '';
      await this.loadFgsRunLog();
    } catch (e) { this.showToast(e.message, 'error'); }
  },
  async loadFgsRunLog(older = false) {
    if (!this.fgsRunId) { this.fgsRunEvents = []; return; }
    const id = this.fgsRunId;
    try {
      const page = await this.api('GET', `/v2/projects/${this.selectedProjectId}/runs/${id}/events?limit=100${older && this.fgsRunEvents.length ? '&before=' + this.fgsRunEvents[0].id : ''}`);
      if (id !== this.fgsRunId) return;
      this.fgsRunEvents = older ? [...page, ...this.fgsRunEvents] : page;
      this.fgsRunHasMore = page.length === 100;
    } catch (e) { this.showToast(e.message, 'error'); }
  },
  fgsRelationLabel(relation) {
    return { scope: '范围约定', derived: '执行产出', supports: '事实支撑', pursues: '执行归属', evidence: '验收依据', subgoal: '子目标归属' }[relation] || relation;
  },
  fgsBuildElements() {
    const selected = this.fgsFocusIds();
    const nodes = this.fgs.nodes.filter(n => !selected || selected.has(n.id)).map(n => {
      const title = n.label.replace(/\s+/g, ' ').trim();
      const short = Array.from(title).slice(0, 32).join('') + (Array.from(title).length > 32 ? '…' : '');
      const label = `${n.nodeType.toUpperCase()} · ${this.factDisplayId(n.id)}\n${short}${n.status ? '\n' + n.status + (n.activeSteps ? ` · ${n.activeSteps} Steps` : '') : ''}`;
      return { data: { ...n, label, fgs: true, width: 180, height: n.status ? 92 : 76 } };
    });
    const ids = new Set(nodes.map(n => n.data.id));
    const edges = this.fgs.edges.filter(e => ids.has(e.source) && ids.has(e.target)).map(e => ({ data: { ...e, fgs: true, label: this.fgsRelationLabel(e.relation) } }));
    return { nodes, edges };
  },
  fgsFocusIds() {
    if (!this.fgsFocusGoal || !this.fgs?.nodes) return null;
    const ids = new Set([this.fgsFocusGoal]);
    // Follow evidence upstream, then preserve the selected goal's path to the root.
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of this.fgs.edges) if (ids.has(edge.target) && !ids.has(edge.source)) { ids.add(edge.source); changed = true; }
    }
    let goal = this.fgs.goals.find(g => g.id === this.fgsFocusGoal);
    const visited = new Set();
    while (goal?.parentId && !visited.has(goal.id)) { visited.add(goal.id); ids.add(goal.parentId); goal = this.fgs.goals.find(g => g.id === goal.parentId); }
    return ids;
  },
  focusFgsGoal(id) {
    this.fgsFocusGoal = id || '';
    this.fgsStepFilter = id || '';
    this.updateGraph();
    this.fitGraph();
  },
  fgsStyles() {
    return [
      { selector: 'node[fgs]', style: { shape: 'round-rectangle', label: 'data(label)', width: 'data(width)', height: 'data(height)', 'text-wrap': 'wrap', 'text-max-width': 164, 'font-size': 12, 'text-valign': 'center', 'text-halign': 'center', 'background-color': '#0c1a28', color: '#dbeeff', 'border-color': '#2c9ed0', 'border-width': 2 } },
      { selector: 'node[nodeType="scope"]', style: { 'background-color': '#0b241c', 'border-color': '#42df86', color: '#d9ffe8' } },
      { selector: 'node[fgs][nodeType="goal"], node[fgs][nodeType="subgoal"]', style: { 'background-color': '#321115', 'border-color': '#ff7a7d' } },
      { selector: 'node[fgs][nodeType="finding"]', style: { 'background-color': '#19122f', 'border-color': '#a783ff' } },
      { selector: 'node[fgs][status="achieved"]', style: { 'border-color': '#42df86' } },
      { selector: 'node[fgs][status="cancelled"]', style: { opacity: 0.6, 'border-style': 'dashed' } },
      { selector: 'edge[fgs]', style: { width: 1.5, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': '#547d96', 'target-arrow-color': '#547d96', label: '', 'font-size': 10, color: '#dbeeff', 'text-background-color': '#070d14', 'text-background-opacity': 1, 'text-background-padding': 3 } },
      { selector: 'edge[relation="scope"], edge[relation="subgoal"], edge[relation="pursues"]', style: { 'line-style': 'dashed', 'line-color': '#80515b', 'target-arrow-color': '#80515b', opacity: 0.65 } },
      { selector: 'edge[relation="evidence"]', style: { width: 2.5, 'line-color': '#42df86', 'target-arrow-color': '#42df86' } },
      { selector: 'edge[relation="supports"]', style: { 'line-color': '#a783ff', 'target-arrow-color': '#a783ff' } },
      { selector: 'edge[fgs].focus, edge[fgs]:selected', style: { label: 'data(label)', width: 3, opacity: 1 } },
      { selector: 'node[fgs].focus, node[fgs]:selected', style: { 'border-width': 4, 'border-color': '#ffffff' } },
    ];
  },
  updateFgsGraph() {
    const { nodes, edges } = this.fgsBuildElements(), elements = [...nodes, ...edges];
    const ids = new Set(elements.map(e => e.data.id));
    let structural = false;
    const zoom = this.cy.zoom(), pan = { ...this.cy.pan() };
    this.cy.batch(() => {
      this.cy.elements().forEach(e => { if (!ids.has(e.id())) { e.remove(); structural = true; } });
      for (const item of elements) {
        const existing = this.cy.getElementById(item.data.id);
        if (!existing.length) { this.cy.add(item); structural = true; }
        else existing.data(item.data);
      }
    });
    if (structural) { this.cy.layout(this.layoutOpts(false)).run(); this.cy.zoom(zoom); this.cy.pan(pan); }
    this.highlightFgsSelection();
  },
  highlightFgsSelection() {
    if (!this.cy || !this.fgs?.nodes) return;
    this.cy.elements().removeClass('focus faded highlight');
    if (this.fgsEdgeSelection) this.cy.getElementById(this.fgsEdgeSelection.id).addClass('focus');
    else if (this.fgsSelection?.type === 'step') {
      this.cy.edges().filter(e => (e.data('stepIds') || []).includes(this.fgsSelection.id)).addClass('focus');
    } else if (this.fgsSelection) {
      const node = this.cy.getElementById(this.fgsSelection.id);
      node.addClass('focus'); node.connectedEdges().addClass('focus');
    }
  },
  selectNativeFgsNode(type, id) {
    this.fgsRuns = []; this.fgsRunId = ''; this.fgsRunEvents = [];
    this.fgsSelection = { type: type === 'subgoal' ? 'goal' : type, id };
    this.fgsEdgeSelection = null;
    this.fgsPanelOpen = true;
    this.sideTab = type === 'step' ? 'steps' : 'fgs';
    this.selectedNode = type === 'step' ? { type: 'intent', id } : ['scope', 'fact'].includes(type) ? { type: 'fact', id } : null;
    this.selectedFacts = ['scope', 'fact'].includes(type) ? [id] : [];
    this.highlightFgsSelection();
    if (type !== 'step' && this.cy?.getElementById(id).length) {
      this.cy.zoom(Math.max(this.cy.zoom(), 0.8));
      this.cy.center(this.cy.getElementById(id));
    }
  },
  selectFgsEdge(edge) {
    this.fgsSelection = null;
    this.fgsEdgeSelection = { ...edge };
    this.sideTab = 'fgs'; this.fgsPanelOpen = true;
    this.highlightFgsSelection();
  },
  fgsRelatedEdges() {
    const id = this.fgsSelection?.id;
    return id ? (this.fgs?.edges || []).filter(e => e.source === id || e.target === id) : this.fgsEdgeSelection ? [this.fgsEdgeSelection] : [];
  },
  fgsRelatedSteps() {
    const id = this.fgsSelection?.id, edgeSteps = this.fgsEdgeSelection?.stepIds || [];
    return (this.fgs?.steps || []).filter(s => !s.deleted && (edgeSteps.includes(s.id) || s.id === id || s.goalId === id || s.sourceIds.includes(id) || s.factIds.includes(id) || this.fgs?.findings.find(f => f.id === id)?.stepId === s.id));
  },
  fgsVisibleSteps() { return (this.fgs?.steps || []).filter(s => !s.deleted && (!this.fgsStepFilter || s.goalId === this.fgsStepFilter)); },
  fgsOpenReference(id) { const n = this.fgs?.nodes.find(n => n.id === id); if (n) this.selectFgsNode(n.nodeType, id); },
  nativeProject(graph) {
    return { project: { ...graph.project, reason: null, bootstrap_enabled: graph.project.bootstrap, created_at: graph.project.createdAt }, facts: [...graph.facts, ...graph.goals.filter(g => g.id === 'goal')], hints: graph.hints.map(h => ({ ...h, created_at: h.createdAt })),
      intents: graph.steps.filter(s => !s.deleted).map(s => ({ ...s, from: s.sourceIds, to: s.status === 'done' ? s.resultGoalId || s.factIds.at(-1) || null : null, state: { pending: 'open', running: 'working', paused: 'open', blocked: 'blocked', done: 'concluded', cancelled: 'dropped' }[s.status], worker: s.status === 'paused' ? null : s.worker, execution_profile: s.executionProfile, created_at: s.createdAt, concluded_at: s.endedAt, failure_count: s.failureCount || 0, failure_signature: s.failure, retry_after: s.retryAfter, circuit_open: s.circuitOpen, attempt_count: s.attempts, cumulative_runtime_ms: s.runtimeMs || 0, fact_yield: s.factIds.length })) };
  },
  async startFgsReplay() {
    const projectId = this.selectedProjectId;
    const sourceProject = this.cloneData(this.project);
    const events = []; let after = 0;
    for (;;) {
      const page = await this.api('GET', `/v2/projects/${projectId}/events?after=${after}&limit=500`);
      events.push(...page); if (page.length < 500) break; after = page.at(-1).id;
    }
    if (!events.length) { this.showToast('无可回放事件', 'error'); return; }
    const frames = events.map(e => ({ revision: e.revision, event: { id: `fgs-${e.id}`, type: e.type, timestamp: e.createdAt, title: e.type, actor: '', meta: [e.nodeId || '', `revision ${e.revision}`], targetType: 'fgs', targetId: e.nodeId, sourceFactIds: [] } }));
    this.stopReplayTimer();
    this.replay = { active: true, native: true, playing: true, stepMs: this.replay.stepMs || '1100', frameIndex: -1, frames, visibleEvents: [], sourceProject, timer: null };
    this.polling = false; this.fgsFocusGoal = ''; this.fgsSelection = null; this.fgsEdgeSelection = null;
    await this.applyFgsReplayFrame(0);
    this.scheduleReplayTick();
  },
  async applyFgsReplayFrame(index) {
    const replay = this.replay, frame = replay.frames[index];
    if (!frame || replay.loading) return;
    replay.loading = true;
    try {
      const graph = await this.api('GET', `/v2/projects/${this.selectedProjectId}/graph?revision=${frame.revision}`);
      if (this.replay !== replay || !replay.active) return;
      this.fgs = graph; this.project = this.nativeProject(graph); replay.frameIndex = index;
      replay.visibleEvents = replay.frames.slice(0, index + 1).map(f => f.event);
      this.updateGraph(); if (index === 0) this.fitGraph();
    } catch (e) { replay.playing = false; this.stopReplayTimer(); this.showToast(e.message, 'error'); }
    finally { replay.loading = false; }
  },
};
