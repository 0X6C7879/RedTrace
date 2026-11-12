import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Store } from './store.ts'
import { HttpError, integer } from './types.ts'
import type { Evidence, Fact } from './types.ts'

export interface ProjectArtifact {
  id: string; projectId: string; path: string; sha256: string; bytes: number; source: Evidence
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Provenance is retained without keeping the producer Run or Session alive. */
export class ProjectEvidence {
  readonly store: Store
  readonly workspaceRoot: string
  constructor(store: Store, workspaceRoot: string) {
    this.store = store; this.workspaceRoot = workspaceRoot
    store.db.exec('CREATE TABLE IF NOT EXISTS project_artifacts(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,' +
      'id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id,id));')
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
    return artifact
  }
  promoteFile(projectId: string, evidence: Evidence) {
    if (!evidence.path) throw new HttpError(422, 'Evidence path is required')
    const root = this.projectRoot(projectId), filename = this.contained(root, path.resolve(root, evidence.path))
    return this.publish(projectId, readFileSync(filename), evidence)
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
          if (source.artifactId) { this.read(projectId, source.artifactId); artifactIds.push(source.artifactId); continue }
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
  artifact(projectId: string, id: string): ProjectArtifact {
    this.store.project(projectId)
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
    const end = Math.min(bytes.length, offset + length)
    return { id, sha256: artifact.sha256, offset, bytes: end - offset, totalBytes: bytes.length,
      nextOffset: end < bytes.length ? end : null, content: bytes.subarray(offset, end).toString('utf8') }
  }
}
