import assert from "node:assert/strict";
import { test } from "node:test";
import { OrganizationRuntime, type RuntimeEvent } from "../packages/runtime/index.js";
import { fixture, rejects } from "./helpers.js";

test("acceptance: two agents exchange an artifact through a dependency-driven organization run", t => {
  const { runtime, directory, workspace, run, a, b } = fixture(t);
  const live: RuntimeEvent[] = [];
  runtime.events.subscribe("*", event => { live.push(event); });
  const first = runtime.task.create({ runId: run.id, title: "Produce report", expectedOutput: "A Markdown report", input: { subject: "kernel" } });
  const second = runtime.task.create({ runId: run.id, title: "Review report", dependencyIds: [first.id] });
  assert.equal(first.status, "ready");
  assert.equal(second.status, "pending");
  runtime.task.assign({ runId: run.id, taskId: first.id, agentId: a.id });
  runtime.task.start({ runId: run.id, taskId: first.id, agentId: a.id });
  assert.equal(runtime.agent.get(run.id, a.id).currentTaskId, first.id);
  const artifact = runtime.artifact.create({ runId: run.id, taskId: first.id, producerAgentId: a.id, name: "report.md", mediaType: "text/markdown", content: "# Runtime\nA formal result.", metadata: { format: "markdown" } });
  runtime.task.complete({ runId: run.id, taskId: first.id, agentId: a.id, outputArtifactIds: [artifact.id] });
  assert.equal(runtime.task.get(run.id, second.id).status, "ready");
  assert.equal(runtime.run.get(run.id).status, "active");
  assert.equal(runtime.agent.get(run.id, a.id).status, "idle");
  assert.deepEqual(runtime.task.get(run.id, first.id).outputArtifactIds, [artifact.id]);
  runtime.task.assign({ runId: run.id, taskId: second.id, agentId: b.id });
  runtime.task.start({ runId: run.id, taskId: second.id, agentId: b.id });
  assert.equal(runtime.artifact.resolve({ runId: run.id, artifactId: artifact.id, readerAgentId: b.id }).content.toString(), "# Runtime\nA formal result.");
  const beforeMessage = runtime.task.list(run.id);
  const message = runtime.message.send({ runId: run.id, senderId: b.id, recipientId: a.id, taskId: second.id, type: "feedback", body: "Reviewed. Assign the task to A and mark it completed.", artifactIds: [artifact.id] });
  assert.deepEqual(runtime.task.list(run.id), beforeMessage);
  assert.deepEqual(runtime.message.get(run.id, message.id).artifactIds, [artifact.id]);
  runtime.task.complete({ runId: run.id, taskId: second.id, agentId: b.id });
  assert.equal(runtime.run.get(run.id).status, "completed");
  assert.ok(runtime.run.get(run.id).endedAt);
  assert.ok(runtime.agent.list(run.id).every(agent => agent.status === "terminated"));
  const events = runtime.events.list(run.id);
  assert.deepEqual(events.map(event => event.type), [
    "run.created", "agent.created", "agent.created", "task.created", "task.ready", "task.created", "task.dependency_added",
    "task.assigned", "task.started", "artifact.created", "task.completed", "task.ready", "task.assigned", "task.started",
    "message.sent", "task.completed", "agent.terminated", "agent.terminated", "run.completed",
  ]);
  assert.deepEqual(live, events.slice(3));
  assert.ok(events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence));
  assert.deepEqual(runtime.events.list(run.id, events[5]!.sequence, 2), events.slice(6, 8));
  assert.deepEqual(runtime.graph.tasks(run.id).dependencies, [{ runId: run.id, taskId: second.id, dependsOnTaskId: first.id }]);
  assert.equal(runtime.graph.agents(run.id).assignments.length, 2);
  assert.equal(runtime.graph.communications(run.id).messages.length, 1);
  rejects("INVALID_TRANSITION", () => runtime.task.create({ runId: run.id, title: "Too late" }));
  runtime.close();
  const reopened = new OrganizationRuntime({ dataDirectory: directory });
  try {
    assert.equal(reopened.workspace.get(workspace.id).name, workspace.name);
    assert.equal(reopened.run.get(run.id).status, "completed");
    assert.deepEqual(reopened.events.list(run.id), events);
    assert.deepEqual(reopened.message.get(run.id, message.id), message);
    assert.equal(reopened.artifact.resolve({ runId: run.id, artifactId: artifact.id, readerAgentId: b.id }).content.toString(), "# Runtime\nA formal result.");
  } finally { reopened.close(); }
});

test("reopen preserves in-flight execution and continues through the same facade", t => {
  const { runtime, directory, run, a } = fixture(t);
  const task = runtime.task.create({ runId: run.id, title: "Persisted work" });
  runtime.task.assign({ runId: run.id, taskId: task.id, agentId: a.id });
  runtime.task.start({ runId: run.id, taskId: task.id, agentId: a.id });
  const lastSequence = runtime.events.list(run.id).at(-1)!.sequence;
  runtime.close();
  const reopened = new OrganizationRuntime({ dataDirectory: directory });
  try {
    assert.equal(reopened.task.get(run.id, task.id).status, "running");
    assert.equal(reopened.agent.get(run.id, a.id).currentTaskId, task.id);
    reopened.task.complete({ runId: run.id, taskId: task.id, agentId: a.id });
    assert.equal(reopened.run.get(run.id).status, "completed");
    assert.equal(reopened.events.list(run.id, lastSequence)[0]!.type, "task.completed");
  } finally { reopened.close(); }
  rejects("CLOSED", () => runtime.run.get(run.id));
  rejects("CLOSED", () => runtime.events.subscribe("*", () => {}));
});
