import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { OrganizationRuntime } from "../packages/runtime/index.js";
import { fixture, rejects } from "./helpers.js";

test("artifact content lives in files, ignores display filenames and detects corruption and loss", t => {
  const { runtime: r, directory, run, a, b } = fixture(t);
  const task = r.task.create({ runId: run.id, title: "producer" });
  const actor = { runId: run.id, taskId: task.id, agentId: a.id };
  r.task.assign(actor);
  r.task.start(actor);
  const content = Buffer.alloc(1024 * 1024, 41);
  const artifact = r.artifact.create({ runId: run.id, taskId: task.id, producerAgentId: a.id, name: "../../escaped.bin", mediaType: "application/octet-stream", content });
  assert.equal(artifact.byteLength, content.length);
  assert.match(artifact.relativePath, /^run_[a-f0-9-]+\/artifact_[a-f0-9-]+\.bin$/);
  const path = join(directory, "artifacts", artifact.relativePath);
  assert.deepEqual(readFileSync(path), content);
  assert.deepEqual(r.artifact.resolve({ runId: run.id, artifactId: artifact.id, readerAgentId: b.id }).content, content);
  writeFileSync(path, Buffer.alloc(content.length, 42));
  rejects("ARTIFACT_CORRUPT", () => r.artifact.resolve({ runId: run.id, artifactId: artifact.id, readerAgentId: b.id }));
  rmSync(path);
  rejects("ARTIFACT_IO", () => r.artifact.resolve({ runId: run.id, artifactId: artifact.id, readerAgentId: b.id }));
});

test("failed artifact SQL commit cleans content and emits nothing; filesystem failure leaves no metadata", t => {
  const { runtime: r, directory, run, a } = fixture(t);
  const task = r.task.create({ runId: run.id, title: "producer" });
  const actor = { runId: run.id, taskId: task.id, agentId: a.id };
  r.task.assign(actor);
  r.task.start(actor);
  const input = { runId: run.id, taskId: task.id, producerAgentId: a.id, name: "result.txt", mediaType: "text/plain", content: "result" };
  const db = new DatabaseSync(join(directory, "runtime.sqlite"));
  const events = r.events.list(run.id);
  let notifications = 0;
  r.events.subscribe("artifact.created", () => { notifications += 1; });
  const runDirectory = join(directory, "artifacts", run.id);
  try {
    db.exec("CREATE TRIGGER test_reject_artifact BEFORE INSERT ON events WHEN NEW.type = 'artifact.created' BEGIN SELECT RAISE(ABORT, 'injected artifact failure'); END;");
    assert.throws(() => r.artifact.create(input), /injected artifact failure/);
    assert.equal(r.artifact.list(run.id).length, 0);
    assert.deepEqual(readdirSync(runDirectory), []);
    assert.deepEqual(r.events.list(run.id), events);
    assert.equal(notifications, 0);
    db.exec("DROP TRIGGER test_reject_artifact");
    rmdirSync(runDirectory); // Known empty directory within this fixture.
    writeFileSync(runDirectory, "An ordinary file blocks directory creation");
    rejects("ARTIFACT_IO", () => r.artifact.create(input));
    assert.equal(r.artifact.list(run.id).length, 0);
    assert.deepEqual(r.events.list(run.id), events);
    rmSync(runDirectory);
    mkdirSync(runDirectory);
    const artifact = r.artifact.create(input);
    assert.equal(r.artifact.list(run.id).length, 1);
    assert.equal(notifications, 1);
    assert.equal(readdirSync(runDirectory).length, 1);
    assert.equal(r.artifact.get(run.id, artifact.id).name, "result.txt");
  } finally { db.close(); }
});

test("SQLite enforces cross-run foreign keys and one running task per agent; no graph/agent queue state exists", t => {
  const { runtime: r, directory, run, workspace, a } = fixture(t);
  const foreignRun = r.run.create({ workspaceId: workspace.id, name: "other" });
  const foreignAgent = r.agent.spawn({ runId: foreignRun.id, name: "other", role: "worker" });
  const foreignTask = r.task.create({ runId: foreignRun.id, title: "other" });
  const first = r.task.create({ runId: run.id, title: "first" });
  const second = r.task.create({ runId: run.id, title: "second" });
  r.task.assign({ runId: run.id, taskId: first.id, agentId: a.id });
  r.task.assign({ runId: run.id, taskId: second.id, agentId: a.id });
  r.task.start({ runId: run.id, taskId: first.id, agentId: a.id });
  const db = new DatabaseSync(join(directory, "runtime.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    assert.throws(() => db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(foreignAgent.id, second.id), /FOREIGN KEY/);
    assert.throws(() => db.prepare("INSERT INTO task_dependencies(run_id, task_id, depends_on_task_id) VALUES (?, ?, ?)").run(run.id, second.id, foreignTask.id), /FOREIGN KEY/);
    assert.throws(() => db.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?").run(new Date().toISOString(), second.id), /UNIQUE/);
    assert.throws(() => db.prepare("UPDATE tasks SET status = 'unknown' WHERE id = ?").run(second.id), /CHECK/);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    assert.deepEqual(tables, ["agent_instances", "artifacts", "events", "message_artifacts", "messages", "runs", "task_artifacts", "task_dependencies", "tasks", "workspaces"]);
    const agentColumns = db.prepare("PRAGMA table_info(agent_instances)").all().map(row => row.name);
    assert.deepEqual(agentColumns, ["id", "run_id", "name", "role", "created_at", "terminated_at"]);
    const artifactColumns = db.prepare("PRAGMA table_info(artifacts)").all().map(row => row.name);
    assert.ok(!artifactColumns.includes("content"));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { db.close(); }
});

test("unknown schema versions fail closed instead of silently migrating or using a fallback", t => {
  const { runtime, directory } = fixture(t);
  runtime.close();
  const db = new DatabaseSync(join(directory, "runtime.sqlite"));
  db.exec("PRAGMA user_version = 999");
  db.close();
  rejects("SCHEMA_VERSION", () => new OrganizationRuntime({ dataDirectory: directory }));
});
