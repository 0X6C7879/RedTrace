CREATE TABLE IF NOT EXISTS shared_resources (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    target TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    secret_json TEXT NOT NULL DEFAULT '{}',
    created_by_type TEXT NOT NULL DEFAULT 'human',
    created_by TEXT NOT NULL,
    worker TEXT,
    intent_id TEXT,
    fact_id TEXT,
    parent_resource_id TEXT REFERENCES shared_resources(id) ON DELETE SET NULL,
    source_task_id TEXT,
    locked_by_type TEXT,
    locked_by TEXT,
    locked_at TEXT,
    worker_paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS project_deletions (
    project_id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_error TEXT,
    actor TEXT NOT NULL DEFAULT 'unknown',
    source TEXT NOT NULL DEFAULT 'unknown'
);

CREATE TABLE IF NOT EXISTS project_delete_authorizations (
    token_hash TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    expires_at REAL NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_delete_authorizations_project
ON project_delete_authorizations(project_id, expires_at);

CREATE TABLE IF NOT EXISTS project_lifecycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    source TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shared_resources_project
ON shared_resources(project_id, kind, updated_at);

CREATE INDEX IF NOT EXISTS idx_shared_resources_parent
ON shared_resources(parent_resource_id);

CREATE TABLE IF NOT EXISTS operation_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    resource_id TEXT NOT NULL REFERENCES shared_resources(id) ON DELETE CASCADE,
    intent_id TEXT,
    fact_id TEXT,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    risk TEXT NOT NULL DEFAULT 'low',
    status TEXT NOT NULL DEFAULT 'queued',
    input_json TEXT NOT NULL DEFAULT '{}',
    output_summary TEXT NOT NULL DEFAULT '',
    result_ref TEXT,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    approved_by TEXT,
    approved_at TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_operation_tasks_project
ON operation_tasks(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_operation_tasks_resource
ON operation_tasks(resource_id, created_at);

CREATE INDEX IF NOT EXISTS idx_operation_tasks_status
ON operation_tasks(status, created_at);

CREATE TABLE IF NOT EXISTS operation_authorizations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    actions_json TEXT NOT NULL,
    resources_json TEXT NOT NULL DEFAULT '[]',
    targets_json TEXT NOT NULL DEFAULT '[]',
    route_ids_json TEXT NOT NULL DEFAULT '[]',
    issued_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operation_authorizations_project
ON operation_authorizations(project_id, expires_at);

CREATE TABLE IF NOT EXISTS resource_leases (
    conflict_key TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL REFERENCES shared_resources(id) ON DELETE CASCADE,
    owner_type TEXT NOT NULL,
    owner TEXT NOT NULL,
    run_id TEXT,
    fencing_token INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_schema (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT OR IGNORE INTO operation_schema VALUES ('version','2');

CREATE TABLE IF NOT EXISTS operation_results (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES operation_tasks(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL DEFAULT 'text/plain',
    content TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    resource_id TEXT,
    task_id TEXT,
    actor_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resource_audit_project
ON resource_audit_events(project_id, id);

CREATE INDEX IF NOT EXISTS idx_resource_audit_resource
ON resource_audit_events(resource_id, id);
