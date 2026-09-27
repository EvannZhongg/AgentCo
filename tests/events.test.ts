import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeEvent } from "../packages/runtime/index.js";
import { fixture } from "./helpers.js";

test("event listeners observe committed state; nested commands retain global event order", t => {
  const { runtime: r, run } = fixture(t);
  const seen: RuntimeEvent[] = [];
  let spawned = false;
  r.events.subscribe("task.created", event => {
    assert.equal(r.task.get(run.id, event.payload.taskId).status, "ready");
    if (!spawned) {
      spawned = true;
      r.agent.spawn({ runId: run.id, name: "From listener", role: "observer" });
    }
  });
  r.events.subscribe("*", event => { seen.push(event); });
  r.task.create({ runId: run.id, title: "Event trigger" });
  assert.deepEqual(seen.map(event => event.type), ["task.created", "task.ready", "agent.created"]);
  assert.ok(seen.every((event, index) => index === 0 || event.sequence > seen[index - 1]!.sequence));
  assert.deepEqual(seen, r.events.list(run.id).slice(-3));
});

test("sync/async listener failures are isolated and event snapshots cannot corrupt other subscribers", async t => {
  const failures: unknown[] = [];
  const { runtime: r, run } = fixture(t, { onListenerError: (error, event) => {
    failures.push(error);
    if (event.type === "task.created") event.payload.taskId = "error-handler-mutation" as typeof event.payload.taskId;
  } });
  r.events.subscribe("task.created", event => { event.payload.taskId = "corrupted" as typeof event.payload.taskId; throw new Error("sync listener failed"); });
  r.events.subscribe("task.created", async () => { throw new Error("async listener failed"); });
  let observed = "";
  const unsubscribe = r.events.subscribe("task.created", event => { observed = event.payload.taskId; });
  const task = r.task.create({ runId: run.id, title: "committed" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(failures.length, 2);
  assert.equal(observed, task.id);
  assert.equal(r.task.get(run.id, task.id).status, "ready");
  assert.equal(r.events.list(run.id).find(event => event.type === "task.created")!.payload.taskId, task.id);
  unsubscribe();
  r.task.create({ runId: run.id, title: "second" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(observed, task.id);
});

test("event-store failure rolls back primary state, derived readiness and live notifications", t => {
  const { runtime: r, directory, run, a } = fixture(t);
  const first = r.task.create({ runId: run.id, title: "first" });
  const second = r.task.create({ runId: run.id, title: "second", dependencyIds: [first.id] });
  const actor = { runId: run.id, taskId: first.id, agentId: a.id };
  r.task.assign(actor);
  r.task.start(actor);
  const db = new DatabaseSync(join(directory, "runtime.sqlite"));
  const seen: RuntimeEvent[] = [];
  r.events.subscribe("*", event => { seen.push(event); });
  const eventsBefore = r.events.list(run.id);
  try {
    db.exec("CREATE TRIGGER test_reject_ready BEFORE INSERT ON events WHEN NEW.type = 'task.ready' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;");
    assert.throws(() => r.task.complete(actor), /injected event failure/);
    assert.equal(r.task.get(run.id, first.id).status, "running");
    assert.equal(r.task.get(run.id, second.id).status, "pending");
    assert.equal(r.agent.get(run.id, a.id).currentTaskId, first.id);
    assert.deepEqual(r.events.list(run.id), eventsBefore);
    assert.equal(seen.length, 0);
    db.exec("DROP TRIGGER test_reject_ready");
    r.task.complete(actor);
    assert.deepEqual(seen.map(event => event.type), ["task.completed", "task.ready"]);
  } finally { db.close(); }
});

test("event history is append-only and runtime package does not export stores or internal services", async t => {
  const { directory } = fixture(t);
  const db = new DatabaseSync(join(directory, "runtime.sqlite"));
  try {
    assert.throws(() => db.exec("UPDATE events SET type = 'fake'"), /append-only/);
    assert.throws(() => db.exec("DELETE FROM events"), /append-only/);
  } finally { db.close(); }
  const exported = await import("@agentco/runtime-kernel");
  assert.deepEqual(Object.keys(exported).sort(), ["OrganizationRuntime", "RuntimeError"]);
  const internalPath = "@agentco/runtime-kernel/persistence";
  await assert.rejects(import(internalPath), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});

test("failed final run event rolls back task completion, agent teardown and run closure together", t => {
  const { runtime: r, directory, run, a } = fixture(t);
  const task = r.task.create({ runId: run.id, title: "final task" });
  const actor = { runId: run.id, taskId: task.id, agentId: a.id };
  r.task.assign(actor);
  r.task.start(actor);
  const db = new DatabaseSync(join(directory, "runtime.sqlite"));
  const before = r.events.list(run.id);
  try {
    db.exec("CREATE TRIGGER test_reject_completion BEFORE INSERT ON events WHEN NEW.type = 'run.completed' BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END;");
    assert.throws(() => r.task.complete(actor), /injected completion failure/);
    assert.equal(r.task.get(run.id, task.id).status, "running");
    assert.equal(r.run.get(run.id).status, "active");
    assert.equal(r.agent.get(run.id, a.id).status, "busy");
    assert.ok(r.agent.list(run.id).every(agent => agent.terminatedAt === null));
    assert.deepEqual(r.events.list(run.id), before);
    db.exec("DROP TRIGGER test_reject_completion");
    r.task.complete(actor);
    assert.equal(r.run.get(run.id).status, "completed");
  } finally { db.close(); }
});
