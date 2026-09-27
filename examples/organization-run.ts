import assert from "node:assert/strict";
import { resolve } from "node:path";
import { OrganizationRuntime } from "../packages/runtime/index.js";

const dataDirectory = resolve(process.argv[2] ?? ".agentco/example");
const runtime = new OrganizationRuntime({ dataDirectory });
try {
  const workspace = runtime.workspace.list()[0] ?? runtime.workspace.create({ name: "Organization Kernel Example" });
  runtime.events.subscribe("*", event => {
    console.log(`${String(event.sequence).padStart(3)} ${event.type} ${JSON.stringify(event.payload)}`);
  });
  const run = runtime.run.create({ workspaceId: workspace.id, name: "Produce and review a report" });
  const a = runtime.agent.spawn({ runId: run.id, name: "Agent A", role: "report producer" });
  const b = runtime.agent.spawn({ runId: run.id, name: "Agent B", role: "reviewer" });
  const first = runtime.task.create({ runId: run.id, title: "Write report", expectedOutput: "A Markdown artifact" });
  const second = runtime.task.create({ runId: run.id, title: "Review report", dependencyIds: [first.id] });
  runtime.task.assign({ runId: run.id, taskId: first.id, agentId: a.id });
  runtime.task.start({ runId: run.id, taskId: first.id, agentId: a.id });
  const artifact = runtime.artifact.create({
    runId: run.id, taskId: first.id, producerAgentId: a.id,
    name: "report.md", mediaType: "text/markdown", content: "# Organization Runtime\nTask, Message, Artifact and Event have separate responsibilities.\n",
  });
  runtime.task.complete({ runId: run.id, taskId: first.id, agentId: a.id, outputArtifactIds: [artifact.id] });
  assert.equal(runtime.task.get(run.id, second.id).status, "ready");
  runtime.task.assign({ runId: run.id, taskId: second.id, agentId: b.id });
  runtime.task.start({ runId: run.id, taskId: second.id, agentId: b.id });
  const result = runtime.artifact.resolve({ runId: run.id, artifactId: artifact.id, readerAgentId: b.id });
  assert.match(result.content.toString(), /Organization Runtime/);
  runtime.message.send({ runId: run.id, senderId: b.id, recipientId: a.id, taskId: second.id, type: "feedback", body: "Reviewed; the runtime boundaries are clear.", artifactIds: [artifact.id] });
  assert.equal(runtime.task.get(run.id, second.id).status, "running");
  runtime.task.complete({ runId: run.id, taskId: second.id, agentId: b.id });
  assert.equal(runtime.run.get(run.id).status, "completed");
  console.log(JSON.stringify({ runId: run.id, status: runtime.run.get(run.id).status, dataDirectory, artifact: artifact.relativePath }, null, 2));
} finally { runtime.close(); }
