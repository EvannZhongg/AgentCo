import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, rejects } from "./helpers.js";

test("illegal transitions, non-owner execution and agent overcommit are rejected without mutation", t => {
  const { runtime: r, run, a, b } = fixture(t);
  const first = r.task.create({ runId: run.id, title: "first" });
  const second = r.task.create({ runId: run.id, title: "second", dependencyIds: [first.id] });
  const third = r.task.create({ runId: run.id, title: "third" });
  const actor = { runId: run.id, taskId: first.id, agentId: a.id };
  const assertUnchanged = (operation: () => unknown, code: Parameters<typeof rejects>[0] = "INVALID_TRANSITION") => {
    const tasks = r.task.list(run.id);
    const events = r.events.list(run.id);
    rejects(code, operation);
    assert.deepEqual(r.task.list(run.id), tasks);
    assert.deepEqual(r.events.list(run.id), events);
  };
  assertUnchanged(() => r.task.start(actor));
  r.task.assign(actor);
  assertUnchanged(() => r.task.assign(actor));
  assertUnchanged(() => r.task.complete(actor));
  assertUnchanged(() => r.task.fail({ ...actor, reason: "not running" }));
  assertUnchanged(() => r.task.start({ ...actor, agentId: b.id }));
  r.task.assign({ ...actor, taskId: second.id });
  assertUnchanged(() => r.task.start({ ...actor, taskId: second.id }));
  r.task.start(actor);
  assertUnchanged(() => r.task.start(actor));
  assertUnchanged(() => r.task.assign({ ...actor, agentId: b.id }));
  assertUnchanged(() => r.task.complete({ ...actor, agentId: b.id }));
  assertUnchanged(() => r.task.addDependency({ runId: run.id, taskId: first.id, dependsOnTaskId: third.id }));
  r.task.assign({ ...actor, taskId: third.id });
  assertUnchanged(() => r.task.start({ ...actor, taskId: third.id }), "AGENT_BUSY");
  assertUnchanged(() => r.agent.terminate({ runId: run.id, agentId: a.id }), "AGENT_HAS_TASKS");
  r.task.complete(actor);
  for (const operation of [
    () => r.task.complete(actor), () => r.task.fail({ ...actor, reason: "late" }), () => r.task.cancel({ ...actor, reason: "late" }),
    () => r.task.assign({ ...actor, agentId: b.id }), () => r.task.start(actor), () => r.task.block({ ...actor, reason: "late" }),
  ]) assertUnchanged(operation);
});

test("DAG fan-in, cycle rejection, dependency edits and graph snapshots", t => {
  const { runtime: r, run, a, b } = fixture(t);
  const first = r.task.create({ runId: run.id, title: "first" });
  const second = r.task.create({ runId: run.id, title: "second" });
  const join = r.task.create({ runId: run.id, title: "join", dependencyIds: [first.id, second.id] });
  const last = r.task.create({ runId: run.id, title: "last", dependencyIds: [join.id] });
  const events = r.events.list(run.id);
  rejects("DEPENDENCY_CYCLE", () => r.task.addDependency({ runId: run.id, taskId: first.id, dependsOnTaskId: last.id }));
  rejects("DEPENDENCY_CYCLE", () => r.task.addDependency({ runId: run.id, taskId: first.id, dependsOnTaskId: first.id }));
  rejects("VALIDATION", () => r.task.addDependency({ runId: run.id, taskId: join.id, dependsOnTaskId: first.id }));
  rejects("VALIDATION", () => r.task.create({ runId: run.id, title: "duplicate", dependencyIds: [first.id, first.id] }));
  assert.deepEqual(r.events.list(run.id), events);
  const detached = r.graph.tasks(run.id);
  detached.dependencies.splice(0);
  detached.tasks[0]!.status = "completed";
  assert.equal(r.graph.tasks(run.id).dependencies.length, 3);
  assert.equal(r.task.get(run.id, first.id).status, "ready");
  for (const [taskId, agentId] of [[first.id, a.id], [second.id, b.id]] as const) {
    r.task.assign({ runId: run.id, taskId, agentId });
    r.task.start({ runId: run.id, taskId, agentId });
    r.task.complete({ runId: run.id, taskId, agentId });
    assert.equal(r.task.get(run.id, join.id).status, taskId === first.id ? "pending" : "ready");
  }
  assert.equal(r.task.get(run.id, last.id).status, "pending");
  r.task.removeDependency({ runId: run.id, taskId: last.id, dependsOnTaskId: join.id });
  assert.equal(r.task.get(run.id, last.id).status, "ready");
  r.task.addDependency({ runId: run.id, taskId: last.id, dependsOnTaskId: join.id });
  assert.equal(r.task.get(run.id, last.id).status, "pending");
});

test("manual blocking, handoff and transitive dependency recovery", t => {
  const { runtime: r, run, a, b } = fixture(t);
  const first = r.task.create({ runId: run.id, title: "first" });
  const second = r.task.create({ runId: run.id, title: "second", dependencyIds: [first.id] });
  const last = r.task.create({ runId: run.id, title: "last", dependencyIds: [second.id] });
  const actor = { runId: run.id, taskId: first.id, agentId: a.id };
  r.task.assign(actor);
  r.task.start(actor);
  r.task.block({ ...actor, reason: "Need information" });
  assert.equal(r.agent.get(run.id, a.id).currentTaskId, null);
  assert.equal(r.task.get(run.id, first.id).blockKind, "manual");
  assert.equal(r.task.get(run.id, second.id).blockKind, "dependency");
  assert.equal(r.task.get(run.id, last.id).blockKind, "dependency");
  rejects("INVALID_TRANSITION", () => r.task.unblock({ runId: run.id, taskId: second.id }));
  rejects("INVALID_TRANSITION", () => r.task.removeDependency({ runId: run.id, taskId: first.id, dependsOnTaskId: second.id }));
  r.task.assign({ ...actor, agentId: b.id });
  r.agent.terminate({ runId: run.id, agentId: a.id });
  r.task.unblock({ runId: run.id, taskId: first.id });
  assert.equal(r.task.get(run.id, first.id).status, "ready");
  assert.equal(r.task.get(run.id, second.id).status, "pending");
  assert.equal(r.task.get(run.id, last.id).status, "pending");
  r.task.start({ ...actor, agentId: b.id });
  r.task.complete({ ...actor, agentId: b.id });
  assert.equal(r.task.get(run.id, second.id).status, "ready");
  assert.equal(r.task.get(run.id, last.id).status, "pending");
});

test("failure blocks downstream work, explicit cancellation settles a failed run", t => {
  const { runtime: r, run, a } = fixture(t);
  const first = r.task.create({ runId: run.id, title: "first" });
  const second = r.task.create({ runId: run.id, title: "second", dependencyIds: [first.id] });
  const last = r.task.create({ runId: run.id, title: "last", dependencyIds: [second.id] });
  const actor = { runId: run.id, taskId: first.id, agentId: a.id };
  r.task.assign(actor);
  r.task.start(actor);
  r.task.fail({ ...actor, reason: "Producer failed" });
  assert.equal(r.task.get(run.id, first.id).failureReason, "Producer failed");
  assert.equal(r.task.get(run.id, second.id).status, "blocked");
  assert.equal(r.task.get(run.id, last.id).status, "blocked");
  assert.equal(r.run.get(run.id).status, "active");
  r.task.cancel({ runId: run.id, taskId: second.id, reason: "Cannot continue" });
  r.task.cancel({ runId: run.id, taskId: last.id, reason: "Cannot continue" });
  assert.equal(r.run.get(run.id).status, "failed");
  assert.equal(r.events.list(run.id).at(-1)!.type, "run.failed");
});

test("removing an unavailable prerequisite recovers an unstarted task", t => {
  const { runtime: r, run } = fixture(t);
  const first = r.task.create({ runId: run.id, title: "first" });
  const second = r.task.create({ runId: run.id, title: "second", dependencyIds: [first.id] });
  r.task.cancel({ runId: run.id, taskId: first.id, reason: "No longer needed" });
  assert.equal(r.task.get(run.id, second.id).status, "blocked");
  r.task.removeDependency({ runId: run.id, taskId: second.id, dependsOnTaskId: first.id });
  assert.equal(r.task.get(run.id, second.id).status, "ready");
  assert.equal(r.task.get(run.id, second.id).blockReason, null);
});

test("empty runs stay active; cancellation atomically terminates all unfinished work and agents", t => {
  const { runtime: r, run, a } = fixture(t);
  assert.equal(r.run.get(run.id).status, "active");
  const first = r.task.create({ runId: run.id, title: "first" });
  r.task.create({ runId: run.id, title: "second", dependencyIds: [first.id] });
  r.task.assign({ runId: run.id, taskId: first.id, agentId: a.id });
  r.task.start({ runId: run.id, taskId: first.id, agentId: a.id });
  r.run.cancel({ runId: run.id, reason: "User cancelled" });
  assert.equal(r.run.get(run.id).status, "cancelled");
  assert.ok(r.task.list(run.id).every(task => task.status === "cancelled"));
  assert.ok(r.agent.list(run.id).every(agent => agent.status === "terminated" && agent.currentTaskId === null));
  rejects("INVALID_TRANSITION", () => r.run.cancel({ runId: run.id, reason: "Again" }));
});

test("terminated agents cannot send, receive, take work or be terminated twice", t => {
  const { runtime: r, run, a, b } = fixture(t);
  const task = r.task.create({ runId: run.id, title: "task" });
  r.agent.terminate({ runId: run.id, agentId: a.id });
  rejects("INVALID_TRANSITION", () => r.task.assign({ runId: run.id, taskId: task.id, agentId: a.id }));
  rejects("INVALID_TRANSITION", () => r.agent.terminate({ runId: run.id, agentId: a.id }));
  rejects("INVALID_TRANSITION", () => r.message.send({ runId: run.id, senderId: a.id, recipientId: b.id, body: "hi", type: "notification" }));
  rejects("INVALID_TRANSITION", () => r.message.send({ runId: run.id, senderId: b.id, recipientId: a.id, body: "hi", type: "notification" }));
});

test("dependency reconciliation reaches a fixed point even when dependents were created first", t => {
  const { runtime: r, run, a } = fixture(t);
  const last = r.task.create({ runId: run.id, title: "last" });
  const middle = r.task.create({ runId: run.id, title: "middle" });
  const first = r.task.create({ runId: run.id, title: "first" });
  r.task.addDependency({ runId: run.id, taskId: last.id, dependsOnTaskId: middle.id });
  r.task.addDependency({ runId: run.id, taskId: middle.id, dependsOnTaskId: first.id });
  const actor = { runId: run.id, taskId: first.id, agentId: a.id };
  r.task.assign(actor);
  r.task.start(actor);
  r.task.block({ ...actor, reason: "Waiting for input" });
  assert.equal(r.task.get(run.id, middle.id).status, "blocked");
  assert.equal(r.task.get(run.id, last.id).status, "blocked");
  r.task.unblock({ runId: run.id, taskId: first.id });
  assert.equal(r.task.get(run.id, first.id).status, "ready");
  assert.equal(r.task.get(run.id, middle.id).status, "pending");
  assert.equal(r.task.get(run.id, last.id).status, "pending");
  r.task.start(actor);
  r.task.complete(actor);
  assert.equal(r.task.get(run.id, middle.id).status, "ready");
  assert.equal(r.task.get(run.id, last.id).status, "pending");
});
