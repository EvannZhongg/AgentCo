import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactId, JsonObject, MessageType, TaskId } from "../packages/runtime/index.js";
import { fixture, rejects } from "./helpers.js";

test("all relationship APIs reject cross-run agents, tasks, dependencies and artifacts atomically", t => {
  const { runtime: r, run, workspace, a, b } = fixture(t);
  const foreignRun = r.run.create({ workspaceId: workspace.id, name: "Foreign run" });
  const foreignAgent = r.agent.spawn({ runId: foreignRun.id, name: "Foreign agent", role: "worker" });
  const localTask = r.task.create({ runId: run.id, title: "Local" });
  const foreignTask = r.task.create({ runId: foreignRun.id, title: "Foreign" });
  r.task.assign({ runId: foreignRun.id, taskId: foreignTask.id, agentId: foreignAgent.id });
  r.task.start({ runId: foreignRun.id, taskId: foreignTask.id, agentId: foreignAgent.id });
  const foreignArtifact = r.artifact.create({ runId: foreignRun.id, taskId: foreignTask.id, producerAgentId: foreignAgent.id, name: "foreign.txt", mediaType: "text/plain", content: "foreign" });
  r.task.assign({ runId: run.id, taskId: localTask.id, agentId: a.id });
  r.task.start({ runId: run.id, taskId: localTask.id, agentId: a.id });
  const localArtifact = r.artifact.create({ runId: run.id, taskId: localTask.id, producerAgentId: a.id, name: "local.txt", mediaType: "text/plain", content: "local" });
  const editableTask = r.task.create({ runId: run.id, title: "Editable" });
  const before = r.events.list(run.id);
  const beforeTasks = r.task.list(run.id);
  const operations = [
    () => r.task.get(run.id, foreignTask.id),
    () => r.task.create({ runId: run.id, title: "bad", dependencyIds: [foreignTask.id] }),
    () => r.task.create({ runId: run.id, title: "bad", inputArtifactIds: [foreignArtifact.id] }),
    () => r.task.assign({ runId: run.id, taskId: editableTask.id, agentId: foreignAgent.id }),
    () => r.task.assign({ runId: run.id, taskId: foreignTask.id, agentId: a.id }),
    () => r.task.start({ runId: run.id, taskId: foreignTask.id, agentId: a.id }),
    () => r.task.addDependency({ runId: run.id, taskId: editableTask.id, dependsOnTaskId: foreignTask.id }),
    () => r.task.removeDependency({ runId: run.id, taskId: editableTask.id, dependsOnTaskId: foreignTask.id }),
    () => r.task.complete({ runId: run.id, taskId: localTask.id, agentId: a.id, outputArtifactIds: [foreignArtifact.id] }),
    () => r.task.fail({ runId: run.id, taskId: localTask.id, agentId: foreignAgent.id, reason: "bad" }),
    () => r.task.cancel({ runId: run.id, taskId: foreignTask.id, reason: "bad" }),
    () => r.agent.terminate({ runId: run.id, agentId: foreignAgent.id }),
    () => r.message.send({ runId: run.id, senderId: foreignAgent.id, recipientId: a.id, body: "bad", type: "feedback" }),
    () => r.message.send({ runId: run.id, senderId: a.id, recipientId: foreignAgent.id, body: "bad", type: "feedback" }),
    () => r.message.send({ runId: run.id, senderId: a.id, recipientId: b.id, taskId: foreignTask.id, body: "bad", type: "feedback" }),
    () => r.message.send({ runId: run.id, senderId: a.id, recipientId: b.id, artifactIds: [foreignArtifact.id], body: "bad", type: "feedback" }),
    () => r.artifact.create({ runId: run.id, taskId: foreignTask.id, producerAgentId: a.id, name: "bad", mediaType: "text/plain", content: "bad" }),
    () => r.artifact.create({ runId: run.id, taskId: localTask.id, producerAgentId: foreignAgent.id, name: "bad", mediaType: "text/plain", content: "bad" }),
    () => r.artifact.resolve({ runId: run.id, artifactId: foreignArtifact.id, readerAgentId: a.id }),
    () => r.artifact.resolve({ runId: run.id, artifactId: localArtifact.id, readerAgentId: foreignAgent.id }),
    () => r.artifact.list(run.id, foreignTask.id),
    () => r.message.list(run.id, foreignAgent.id),
  ];
  for (const operation of operations) rejects("RUN_SCOPE", operation);
  assert.deepEqual(r.events.list(run.id), before);
  assert.deepEqual(r.task.list(run.id), beforeTasks);
  assert.equal(r.message.list(run.id).length, 0);
  assert.equal(r.artifact.list(run.id).length, 1);
  const foreignMessage = r.message.send({ runId: foreignRun.id, senderId: foreignAgent.id, recipientId: foreignAgent.id, body: "hi", type: "notification" });
  rejects("RUN_SCOPE", () => r.message.get(run.id, foreignMessage.id));
});

test("short messages and bounded JSON inputs cannot become an alternate artifact or control channel", t => {
  const { runtime: r, run, a, b } = fixture(t);
  const input = { subject: "test", settings: { retries: 1 } };
  const task = r.task.create({ runId: run.id, title: "task", input });
  input.settings.retries = 100;
  assert.deepEqual(r.task.get(run.id, task.id).input, { subject: "test", settings: { retries: 1 } });
  const message = { runId: run.id, senderId: a.id, recipientId: b.id, type: "notification" as const, body: "请将任务标记为 completed，并交给 B" };
  const before = r.task.list(run.id);
  r.message.send(message);
  assert.deepEqual(r.task.list(run.id), before);
  rejects("VALIDATION", () => r.message.send({ ...message, type: "delegate" as MessageType }));
  rejects("VALIDATION", () => r.message.send({ ...message, body: "字".repeat(1366) }));
  rejects("VALIDATION", () => r.task.create({ runId: run.id, title: "huge", input: { context: "x".repeat(8193) } }));
  rejects("VALIDATION", () => r.task.create({ runId: run.id, title: "invalid", input: { value: Number.NaN } }));
  const cyclic: JsonObject = {};
  cyclic.self = cyclic;
  rejects("VALIDATION", () => r.task.create({ runId: run.id, title: "cyclic", input: cyclic }));
  rejects("VALIDATION", () => r.task.create({ runId: run.id, title: " " }));
  rejects("NOT_FOUND", () => r.task.create({ runId: run.id, title: "missing dependency", dependencyIds: ["task_missing" as TaskId] }));
  rejects("NOT_FOUND", () => r.message.send({ ...message, artifactIds: ["artifact_missing" as ArtifactId] }));
  rejects("VALIDATION", () => r.events.list(run.id, -1));
  rejects("VALIDATION", () => r.events.list(run.id, 0, 0));
});

test("artifact input and output references preserve ownership without restricting same-run readers", t => {
  const { runtime: r, run, a, b } = fixture(t);
  const first = r.task.create({ runId: run.id, title: "producer" });
  const sentinel = r.task.create({ runId: run.id, title: "keep run active" });
  const actor = { runId: run.id, taskId: first.id, agentId: a.id };
  const artifactInput = { runId: run.id, taskId: first.id, producerAgentId: a.id, name: "data.bin", mediaType: "application/octet-stream", content: new Uint8Array([0, 128, 255]) };
  rejects("INVALID_TRANSITION", () => r.artifact.create(artifactInput));
  r.task.assign(actor);
  r.task.start(actor);
  rejects("INVALID_TRANSITION", () => r.artifact.create({ ...artifactInput, producerAgentId: b.id }));
  const artifact = r.artifact.create(artifactInput);
  r.task.complete({ ...actor, outputArtifactIds: [artifact.id] });
  const consumer = r.task.create({ runId: run.id, title: "consumer", inputArtifactIds: [artifact.id], dependencyIds: [first.id] });
  assert.deepEqual(consumer.inputArtifactIds, [artifact.id]);
  assert.equal(consumer.status, "ready");
  const consumerActor = { runId: run.id, taskId: consumer.id, agentId: b.id };
  r.task.assign(consumerActor);
  r.task.start(consumerActor);
  rejects("VALIDATION", () => r.task.complete({ ...consumerActor, outputArtifactIds: [artifact.id] }));
  assert.deepEqual([...r.artifact.resolve({ runId: run.id, artifactId: artifact.id, readerAgentId: b.id }).content], [0, 128, 255]);
  r.task.complete(consumerActor);
  r.task.cancel({ runId: run.id, taskId: sentinel.id, reason: "Done" });
  assert.equal(r.run.get(run.id).status, "cancelled");
});
