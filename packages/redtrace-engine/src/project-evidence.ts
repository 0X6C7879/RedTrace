import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Store } from './store.ts'
import { HttpError, integer } from './types.ts'
import type { Evidence, Fact, Finding, Json, GraphNode } from './types.ts'

export interface ProjectArtifact {
  id: string; projectId: string; path: string; sha256: string; bytes: number; source: Evidence
}

/** Structural slice of the mounted DSH services; storage formats stay owned by DSH. */
export interface EvidenceSessionServices {
  sessionPersistence: {
    list(): Promise<readonly { header: { id: string; cwd?: string }; revision: unknown }[]>
    stat(id: string): Promise<{ revision: unknown } | undefined>
    open(id: string, access: 'read'): Promise<{ read(): Promise<{ events: readonly unknown[] }>; close(): Promise<void> }>
  }
  attachments: {
    readImage(ref: any): Promise<{ data: Uint8Array }>
    readFileStream(ref: any): AsyncIterable<Uint8Array>
  }
}
export interface RetentionIssue { owner: string; pointer: string; reason: string }
export interface RetainedReference { owner: string; pointer: string; artifactId: string }

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Provenance is retained without keeping the producer Run or Session alive. */
export class ProjectEvidence {
  readonly store: Store
  readonly workspaceRoot: string
  constructor(store: Store, workspaceRoot: string) {
    this.store = store; this.workspaceRoot = workspaceRoot
    store.db.exec('CREATE TABLE IF NOT EXISTS project_artifact_graphs(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, graph_id TEXT NOT NULL REFERENCES project_graphs(id) ON DELETE CASCADE, artifact_id TEXT NOT NULL, PRIMARY KEY(project_id,graph_id,artifact_id));')
    store.db.exec('CREATE TABLE IF NOT EXISTS project_artifacts(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,' +
      'id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id,id));' +
      'CREATE TABLE IF NOT EXISTS project_evidence_refs(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, owner TEXT NOT NULL, pointer TEXT NOT NULL, data TEXT NOT NULL, artifact_id TEXT NOT NULL, PRIMARY KEY(project_id,owner,pointer));')
    if(!store.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('artifact-graphs'))store.transaction(()=>{
      store.db.exec("INSERT OR IGNORE INTO project_artifact_graphs SELECT a.project_id,g.id,a.id FROM project_artifacts a JOIN project_graphs g ON a.project_id=g.project_id WHERE json_extract(g.data,'$.type')='main'")
      store.db.prepare('INSERT INTO metadata VALUES (?,?)').run('artifact-graphs','1')
    })
  }
  private projectRoot(projectId: string) {
    this.store.project(projectId)
    const root = realpathSync(this.workspaceRoot), project = realpathSync(path.join(root, projectId))
    if (!project.startsWith(root + path.sep)) throw new HttpError(403, 'Project workspace escapes workspace root')
    return project
  }
  private contained(root: string, filename: string) {
    const file = realpathSync(filename), relative = path.relative(root, file)
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new HttpError(403, 'Evidence escapes Project workspace')
    if (relative.split(path.sep).some(part => /^(?:\.env(?:\..*)?|\.redtrace-secrets|\.redtrace|\.ssh|\.aws|\.credentials|secrets?)$/i.test(part))) throw new HttpError(403, 'Private credentials are not evidence')
    return file
  }
  publish(projectId: string, bytes: Uint8Array, source: Evidence): ProjectArtifact {
    const root = this.projectRoot(projectId), sha256 = digest(bytes), id = 'artifact-' + sha256
    const output = path.join(root, '.redtrace-output')
    mkdirSync(output, { recursive: true })
    const directory = path.join(this.contained(root, output), 'project-evidence')
    mkdirSync(directory, { recursive: true })
    // Resolve the directory before writing: a symlink must not turn promotion into an escape.
    const targetRoot = this.contained(root, directory), filename = path.join(targetRoot, sha256)
    try { writeFileSync(filename, bytes, { flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const file = this.contained(root, filename)
    if (digest(readFileSync(file)) !== sha256) throw new HttpError(409, 'Existing evidence artifact hash mismatch')
    const artifact: ProjectArtifact = { id, projectId, path: path.relative(root, file), sha256, bytes: bytes.byteLength, source: { ...source } }
    this.store.db.prepare('INSERT OR IGNORE INTO project_artifacts VALUES (?,?,?)').run(projectId, id, JSON.stringify(artifact))
    const graphId=this.store.graphScope??this.store.projectGraphs(projectId).find(g=>g.type==='main')?.id
    if(graphId)this.store.db.prepare('INSERT OR IGNORE INTO project_artifact_graphs VALUES (?,?,?)').run(projectId,graphId,id)
    return artifact
  }
  promoteFile(projectId: string, evidence: Evidence, cwd?:string) {
    if (!evidence.path) throw new HttpError(422, 'Evidence path is required')
    const root = this.projectRoot(projectId), filename = this.contained(root, path.resolve(cwd??root, evidence.path))
    if(cwd)this.contained(realpathSync(cwd),filename)
    evidence={...evidence,path:path.relative(root,filename)}
    return this.publish(projectId, readFileSync(filename), evidence)
  }
  private promoteSource(projectId: string, source: Evidence): ProjectArtifact {
    if (source.artifactId) { this.verifyArtifact(projectId, source.artifactId); return this.artifact(projectId, source.artifactId) }
    let artifact: ProjectArtifact
    if (source.path) artifact = this.promoteFile(projectId, source)
    else if (source.runId && source.toolCallId) {
      const run = this.store.run(source.runId)
      if (run.projectId !== projectId) throw new HttpError(403, 'Evidence producer belongs to another Project')
      const rows = this.store.db.prepare("SELECT data FROM audit_events WHERE project_id=? AND run_id=? AND json_extract(data,'$.kind')='tool.completed' AND json_extract(data,'$.call_id')=? ORDER BY id").all(projectId, source.runId, source.toolCallId)
      if (!rows.length) throw new HttpError(404, 'Referenced tool result is missing')
      const records = rows.map(row => JSON.parse(String(row.data)))
      const spillIds = [...new Set(JSON.stringify(records).match(/ev-[a-f0-9]{64}/g) ?? [])]
      const attachments: { id: string; artifactId: string }[] = []
      for (const id of spillIds) {
        const filename = path.join(this.projectRoot(projectId), '.redtrace-output', 'evidence', run.id, id + '.json')
        if (!existsSync(filename)) throw new HttpError(404, 'Referenced spill evidence is missing: ' + id)
        const bytes = readFileSync(this.contained(this.projectRoot(projectId), filename))
        if (digest(bytes) !== id.slice(3)) throw new HttpError(409, 'Referenced spill evidence hash mismatch')
        attachments.push({ id, artifactId: this.publish(projectId, bytes, source).id })
      }
      artifact = this.publish(projectId, Buffer.from(JSON.stringify({ records, attachments })), source)
    } else if (source.runId || source.toolCallId) throw new HttpError(422, 'Run evidence needs an explicit file or tool call reference')
    else artifact = this.publish(projectId, Buffer.from(JSON.stringify(source)), source)
    return artifact
  }
  private verifyArtifact(projectId: string, id: string) {
    this.read(projectId, id)
    const artifact = this.artifact(projectId, id)
    if (artifact.source.runId && artifact.source.toolCallId && !artifact.source.path) {
      const root = this.projectRoot(projectId)
      const content = readFileSync(this.contained(root, path.resolve(root, artifact.path)), 'utf8')
      // Only promoteSource's envelope has child artifacts; provenance alone does not make raw bytes JSON.
      if (!content.startsWith('{"records":[')) return
      const value = JSON.parse(content)
      for (const attachment of value.attachments ?? []) this.read(projectId, attachment.artifactId)
    }
  }
  promoteFacts(projectId: string) {
    this.store.project(projectId)
    const promoted: { factId: string; artifactIds: string[] }[] = []
    const unresolved: { factId: string; evidenceIndex: number; reason: string }[] = []
    for (const fact of this.store.nodes<Fact>(projectId, ['fact'])) {
      const evidence = [...fact.evidence], artifactIds: string[] = []
      let changed = false
      for (let index = 0; index < evidence.length; index++) {
        const source = evidence[index]
        try {
          if (source.artifactId) { this.verifyArtifact(projectId, source.artifactId); artifactIds.push(source.artifactId); continue }
          const artifact = this.promoteSource(projectId, source)
          evidence[index] = { ...source, artifactId: artifact.id }; artifactIds.push(artifact.id); changed = true
        } catch (error) {
          unresolved.push({ factId: fact.id, evidenceIndex: index, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      if (changed) this.store.transaction(() => {
        const current = this.store.node<Fact>(projectId, fact.id, 'fact')
        if (current.version !== fact.version) throw new HttpError(409, 'Fact changed while preserving evidence')
        current.evidence = evidence; this.store.saveNode(current)
        this.store.event(projectId, 'fact.evidence_promoted', current, {})
      })
      promoted.push({ factId: fact.id, artifactIds })
    }
    return { projectId, scope: 'fact-evidence' as const, promoted, unresolved, factsReady: unresolved.length === 0 }
  }

  /** Preserve explicit references without turning arbitrary prose into evidence. */
  async promoteRetained(projectId: string, services: EvidenceSessionServices) {
    const facts = this.promoteFacts(projectId)
    const unresolved: RetentionIssue[] = facts.unresolved.map(item => ({ owner: item.factId, pointer: '/evidence/' + item.evidenceIndex, reason: item.reason }))
    const references: RetainedReference[] = []
    let expectedRevision = this.store.project(projectId).revision
    const checkRevision = () => {
      if (this.store.project(projectId).revision !== expectedRevision) unresolved.push({ owner: projectId, pointer: '', reason: 'Project changed during evidence preservation' })
    }
    const record = (owner: string, pointer: string, source: unknown, artifactId: string) => {
      this.store.db.prepare('INSERT INTO project_evidence_refs VALUES (?,?,?,?,?) ON CONFLICT(project_id,owner,pointer) DO UPDATE SET data=CASE WHEN artifact_id=excluded.artifact_id THEN data ELSE excluded.data END,artifact_id=excluded.artifact_id')
        .run(projectId, owner, pointer, JSON.stringify(source), artifactId)
      references.push({ owner, pointer, artifactId })
    }
    const visit = async (value: unknown, owner: string, pointer: string, attachmentsOnly = false): Promise<any> => {
      if (Array.isArray(value)) return Promise.all(value.map((item, index) => visit(item, owner, pointer + '/' + index, attachmentsOnly)))
      if (!value || typeof value !== 'object') {
        // Free-text local references have no reliable grammar: require explicit resolution, never silently declare them safe.
        if (!attachmentsOnly && typeof value === 'string' && /(?:file:\/\/|(?:^|[\s(])(?:\/|\.\.?\/)|ev-[a-f0-9]{64}|attachmentId|sessionId)/.test(value))
          unresolved.push({ owner, pointer, reason: 'Unstructured reference requires explicit evidence mapping' })
        return value
      }
      const input = value as Record<string, any>
      try {
        if ('attachmentId' in input) {
          if (typeof input.attachmentId !== 'string') throw new HttpError(422, 'Invalid attachment reference')
          if (!attachmentsOnly && !this.store.db.prepare("SELECT 1 FROM project_evidence_refs WHERE project_id=? AND json_extract(data,'$.attachmentId')=?").get(projectId, input.attachmentId))
            throw new HttpError(403, 'Attachment has no preserved Session reference in this Project')
          const hash = /^sha256:([a-f0-9]{64})$/.exec(input.attachmentId)?.[1]
          if (!hash || !Number.isSafeInteger(input.bytes) || input.bytes < 0) throw new HttpError(422, 'Invalid attachment reference')
          const saved = this.store.db.prepare('SELECT data,artifact_id FROM project_evidence_refs WHERE project_id=? AND owner=? AND pointer=?').get(projectId, owner, pointer)
          let artifact: ProjectArtifact
          if (saved && String(saved.data) === JSON.stringify(input)) {
            artifact = this.artifact(projectId, String(saved.artifact_id)); this.read(projectId, artifact.id)
          } else {
            let bytes: Uint8Array
            if (input.mediaType) bytes = (await services.attachments.readImage(input)).data
            else {
              const chunks: Uint8Array[] = []
              for await (const chunk of services.attachments.readFileStream(input)) chunks.push(chunk)
              bytes = Buffer.concat(chunks)
            }
            if (digest(bytes) !== hash || bytes.byteLength !== input.bytes) throw new HttpError(409, 'Attachment hash or byte count mismatch')
            artifact = this.publish(projectId, bytes, { description: owner + pointer })
          }
          if (artifact.sha256 !== hash || artifact.bytes !== input.bytes) throw new HttpError(409, 'Preserved attachment does not match reference')
          record(owner, pointer, input, artifact.id)
          return { artifactId: artifact.id }
        }
        if (!attachmentsOnly && ['path', 'artifactId', 'runId', 'toolCallId'].some(key => key in input)) {
          for (const key of ['path', 'artifactId', 'runId', 'toolCallId']) if (key in input && typeof input[key] !== 'string') throw new HttpError(422, 'Invalid evidence field: ' + key)
          const artifact = this.promoteSource(projectId, { ...input, description: input.description || owner + pointer })
          record(owner, pointer, input, artifact.id)
          const retained: Record<string, unknown> = { artifactId: artifact.id }
          for (const [key, child] of Object.entries(input)) if (!['path', 'artifactId', 'runId', 'toolCallId'].includes(key)) retained[key] = await visit(child, owner, pointer + '/' + key)
          return retained
        }
        if (!attachmentsOnly && ('sessionId' in input || 'filePath' in input || 'attachment' in input && !input.attachment))
          throw new HttpError(422, 'Unsupported reference requires explicit evidence mapping')
        const result: Record<string, unknown> = {}
        for (const [key, child] of Object.entries(input)) result[key] = await visit(child, owner, pointer + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'), attachmentsOnly)
        return result
      } catch (error) {
        unresolved.push({ owner, pointer, reason: error instanceof Error ? error.message : String(error) })
        return value
      }
    }
    const runs = this.store.runs(projectId)
    const audit = this.store.db.prepare('SELECT data FROM audit_runs WHERE project_id=?').all(projectId).map(row => JSON.parse(String(row.data)))
    const expected = new Set(runs.filter(run => run.backend === 'dsh').map(run => run.id))
    for (const run of audit) if (run.engine === 'dsh' && run.session_id) expected.add(run.session_id)
    const sessions: string[] = [], root = this.projectRoot(projectId)
    try {
      const inventory = await services.sessionPersistence.list()
      for (const snapshot of inventory) {
        const { id, cwd } = snapshot.header
        const directory = cwd ? (existsSync(cwd) ? realpathSync(cwd) : path.resolve(cwd)) : ''
        const belongs = directory === root || directory.startsWith(root + path.sep)
        if (!belongs && !expected.has(id)) continue
        sessions.push(id); expected.delete(id)
        if (!belongs) { unresolved.push({ owner: id, pointer: '', reason: 'Session workspace belongs to another Project' }); continue }
        try {
          const handle = await services.sessionPersistence.open(id, 'read')
          try { await visit((await handle.read()).events, 'session:' + id, '/events', true) }
          finally { await handle.close() }
          if ((await services.sessionPersistence.stat(id))?.revision !== snapshot.revision) throw new HttpError(409, 'Session changed during evidence preservation')
        } catch (error) { unresolved.push({ owner: id, pointer: '', reason: error instanceof Error ? error.message : String(error) }) }
      }
      for (const id of expected) unresolved.push({ owner: id, pointer: '', reason: 'Referenced Agent Session is missing' })
    } catch (error) { unresolved.push({ owner: 'sessions', pointer: '', reason: error instanceof Error ? error.message : String(error) }) }
    for (const finding of this.store.nodes<Finding>(projectId, ['finding'])) {
      const details = await visit(finding.details, finding.id, '/details') as Json
      checkRevision()
      if (JSON.stringify(details) !== JSON.stringify(finding.details)) this.store.transaction(() => {
        const current = this.store.node<Finding>(projectId, finding.id, 'finding')
        if (current.version !== finding.version) throw new HttpError(409, 'Finding changed while preserving evidence')
        current.details = details; this.store.saveNode(current); this.store.event(projectId, 'finding.evidence_promoted', current, {})
        expectedRevision = this.store.project(projectId).revision
      })
    }
    checkRevision()
    return { projectId, scope: 'retained-evidence' as const, facts, references, sessions, unresolved, evidenceReady: unresolved.length === 0 }
  }
  retainedReferences(projectId: string): RetainedReference[] {
    this.store.project(projectId)
    return this.store.db.prepare('SELECT owner,pointer,artifact_id FROM project_evidence_refs WHERE project_id=?').all(projectId)
      .map(row => ({ owner: String(row.owner), pointer: String(row.pointer), artifactId: String(row.artifact_id) }))
  }
  /** This produces evidence and a detach plan, never a deletion authorization or runtime-stop claim. */
  async preflightReset(projectId: string, services: EvidenceSessionServices) {
    const preservation = await this.promoteRetained(projectId, services)
    const blockers: RetentionIssue[] = [...preservation.unresolved]
    const block = (owner: string, reason: string) => blockers.push({ owner, pointer: '', reason })
    if (!['stopped', 'completed'].includes(this.store.project(projectId).status)) block(projectId, 'Project scheduling is not stopped')
    for (const run of this.store.runs(projectId)) if (['running', 'paused', 'unknown'].includes(run.status) || run.pendingTools.length) block(run.id, 'Execution or tool outcome is not confirmed stopped')
    const table = (name: string) => !!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
    if (table('project_campaigns')) {
      const row = this.store.db.prepare('SELECT data FROM project_campaigns WHERE project_id=?').get(projectId)
      if (row && JSON.parse(String(row.data)).status === 'running') block('commander', 'Commander is running')
    }
    if (table('operation_tasks')) for (const row of this.store.db.prepare("SELECT id FROM operation_tasks WHERE project_id=? AND status NOT IN ('succeeded','failed','cancelled','rejected')").all(projectId)) block(String(row.id), 'Resource operation has not settled')
    if (table('resource_leases')) for (const row of this.store.db.prepare("SELECT l.run_id FROM resource_leases l JOIN shared_resources r ON r.id=l.resource_id WHERE (r.project_id=? OR l.run_id IN (SELECT id FROM runs WHERE project_id=?)) AND l.expires_at>?").all(projectId, projectId, new Date().toISOString())) block(String(row.run_id), 'Resource lease is still active')
    const nodes = this.store.nodes(projectId, ['fact', 'finding', 'goal', 'hint', 'observation', 'step']), retained = nodes.filter(node => node.kind !== 'step'), ids = new Set(retained.map(node => node.id))
    const detachments: { nodeId: string; before: GraphNode; after: GraphNode }[] = []
    for (const node of nodes) {
      if (node.kind === 'step') { if (['running', 'paused'].includes(node.status)) block(node.id, 'Step execution is not stopped'); continue }
      const dependencies = node.kind === 'goal' ? [...node.evidenceIds, ...(node.parentId ? [node.parentId] : [])] : node.kind === 'finding' ? node.factIds : []
      for (const id of dependencies) if (!ids.has(id)) block(node.id, 'Retained graph dependency is missing: ' + id)
      const after = structuredClone(node)
      if ('stepId' in after) after.stepId = null
      if ('producerStepIds' in after) after.producerStepIds = []
      if (after.kind === 'fact') after.evidence = after.evidence.map(source => source.artifactId ? { artifactId: source.artifactId, description: source.description } : source)
      if (JSON.stringify(node) !== JSON.stringify(after)) detachments.push({ nodeId: node.id, before: node, after })
    }
    for (const ref of this.retainedReferences(projectId)) {
      try { this.verifyArtifact(projectId, ref.artifactId) }
      catch (error) { blockers.push({ owner: ref.owner, pointer: ref.pointer, reason: error instanceof Error ? error.message : String(error) }) }
    }
    return { projectId, scope: 'project-runtime-reset' as const, observedRevision: this.store.project(projectId).revision, preservation, detachments, blockers,
      dataReady: blockers.length === 0, cleanupAllowed: false as const, remainingGate: 'E2-E6 acceptance, confirmed runtime stop and consistent backup are required at E7' }
  }

  artifact(projectId: string, id: string): ProjectArtifact {
    this.store.project(projectId)
    if(this.store.graphScope&&!this.store.db.prepare('SELECT 1 FROM project_artifact_graphs WHERE project_id=? AND graph_id=? AND artifact_id=?').get(projectId,this.store.graphScope,id))throw new HttpError(404,'Artifact is not in this Graph')
    const row = this.store.db.prepare('SELECT data FROM project_artifacts WHERE project_id=? AND id=?').get(projectId, id)
    if (!row) throw new HttpError(404, 'Project evidence artifact not found')
    return JSON.parse(String(row.data))
  }
  read(projectId: string, id: string, offset = 0, length = 7600) {
    integer(offset, 'offset'); integer(length, 'length', 1)
    if (length > 7600) throw new HttpError(422, 'Evidence read length exceeds 7600 bytes')
    const artifact = this.artifact(projectId, id), root = this.projectRoot(projectId)
    const bytes = readFileSync(this.contained(root, path.resolve(root, artifact.path)))
    if (digest(bytes) !== artifact.sha256 || bytes.length !== artifact.bytes) throw new HttpError(409, 'Project evidence hash mismatch')
    if (offset > bytes.length) throw new HttpError(422, 'Offset is outside this artifact')
    const end = Math.min(bytes.length, offset + length), chunk = bytes.subarray(offset, end), text = isUtf8(chunk)
    return { id, sha256: artifact.sha256, offset, bytes: end - offset, totalBytes: bytes.length,
      nextOffset: end < bytes.length ? end : null, content: chunk.toString(text ? 'utf8' : 'base64'), ...(text ? {} : { encoding: 'base64' as const }) }
  }
}
