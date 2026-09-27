// One initial schema, one execution path. Future changes require numbered migrations.
export const SCHEMA_VERSION = 1;
export const SCHEMA_SQL = `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE runs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','completed','failed','cancelled')),
  created_at TEXT NOT NULL, ended_at TEXT,
  CHECK ((status = 'active') = (ended_at IS NULL))
) STRICT;
CREATE INDEX runs_workspace ON runs(workspace_id);
CREATE TABLE agent_instances (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  name TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, terminated_at TEXT,
  UNIQUE(run_id, id)
) STRICT;
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  title TEXT NOT NULL, description TEXT NOT NULL, expected_output TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','ready','running','blocked','completed','failed','cancelled')),
  assignee_id TEXT, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  block_kind TEXT CHECK(block_kind IN ('manual','dependency')), block_reason TEXT,
  failure_reason TEXT, cancellation_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  started_at TEXT, ended_at TEXT, UNIQUE(run_id, id),
  FOREIGN KEY(run_id, assignee_id) REFERENCES agent_instances(run_id, id),
  CHECK ((status = 'blocked') = (block_kind IS NOT NULL)),
  CHECK ((block_kind IS NULL) = (block_reason IS NULL)),
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancellation_reason IS NOT NULL)),
  CHECK ((status IN ('completed','failed','cancelled')) = (ended_at IS NOT NULL)),
  CHECK (status NOT IN ('running','completed','failed') OR (assignee_id IS NOT NULL AND started_at IS NOT NULL))
) STRICT;
CREATE INDEX tasks_run_status ON tasks(run_id, status);
CREATE INDEX tasks_assignee ON tasks(run_id, assignee_id);
CREATE UNIQUE INDEX one_running_task_per_agent ON tasks(assignee_id) WHERE status = 'running';
CREATE TABLE task_dependencies (
  run_id TEXT NOT NULL, task_id TEXT NOT NULL, depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY(run_id, task_id, depends_on_task_id), CHECK(task_id <> depends_on_task_id),
  FOREIGN KEY(run_id, task_id) REFERENCES tasks(run_id, id),
  FOREIGN KEY(run_id, depends_on_task_id) REFERENCES tasks(run_id, id)
) STRICT;
CREATE INDEX dependency_dependents ON task_dependencies(run_id, depends_on_task_id);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, producer_agent_id TEXT NOT NULL,
  name TEXT NOT NULL, media_type TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE,
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0), sha256 TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)), created_at TEXT NOT NULL, UNIQUE(run_id, id),
  FOREIGN KEY(run_id, task_id) REFERENCES tasks(run_id, id),
  FOREIGN KEY(run_id, producer_agent_id) REFERENCES agent_instances(run_id, id)
) STRICT;
CREATE INDEX artifacts_task ON artifacts(run_id, task_id);
CREATE TABLE task_artifacts (
  run_id TEXT NOT NULL, task_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('input','output')),
  PRIMARY KEY(run_id, task_id, artifact_id, direction),
  FOREIGN KEY(run_id, task_id) REFERENCES tasks(run_id, id),
  FOREIGN KEY(run_id, artifact_id) REFERENCES artifacts(run_id, id)
) STRICT;
CREATE TABLE messages (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
  task_id TEXT, type TEXT NOT NULL CHECK(type IN ('request_info','response','feedback','review_request','notification')),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= 4096), created_at TEXT NOT NULL, UNIQUE(run_id, id),
  FOREIGN KEY(run_id, sender_id) REFERENCES agent_instances(run_id, id),
  FOREIGN KEY(run_id, recipient_id) REFERENCES agent_instances(run_id, id),
  FOREIGN KEY(run_id, task_id) REFERENCES tasks(run_id, id)
) STRICT;
CREATE INDEX messages_recipient ON messages(run_id, recipient_id);
CREATE TABLE message_artifacts (
  run_id TEXT NOT NULL, message_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
  PRIMARY KEY(run_id, message_id, artifact_id),
  FOREIGN KEY(run_id, message_id) REFERENCES messages(run_id, id),
  FOREIGN KEY(run_id, artifact_id) REFERENCES artifacts(run_id, id)
) STRICT;
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES runs(id),
  type TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), occurred_at TEXT NOT NULL
) STRICT;
CREATE INDEX events_run_sequence ON events(run_id, sequence);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`;
