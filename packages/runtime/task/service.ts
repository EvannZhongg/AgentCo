import { invariant } from "../../shared/errors.js";
import { newId, type AgentId, type ArtifactId, type RunId, type TaskId } from "../../shared/ids.js";
import type { JsonObject, Task } from "../../shared/models.js";
import { jsonObject, text, uniqueIds } from "../../shared/validation.js";
import type { RuntimeContext } from "../context.js";
import { settleRun } from "../run/lifecycle.js";
import { assertDependenciesEditable, insertDependency, reconcileDependencies } from "./dependencies.js";
import { cancelTask, isTerminal } from "./lifecycle.js";

export interface TaskRef { runId: RunId; taskId: TaskId }
export interface TaskActor extends TaskRef { agentId: AgentId }
export interface CreateTask {
  runId: RunId; title: string; description?: string; expectedOutput?: string; input?: JsonObject;
  dependencyIds?: readonly TaskId[]; inputArtifactIds?: readonly ArtifactId[];
}

export class TaskService {
  constructor(private readonly ctx: RuntimeContext) {}
  #editable(input: TaskRef): Task {
    this.ctx.read.activeRun(input.runId);
    const task = this.ctx.read.task(input.runId, input.taskId);
    invariant(!isTerminal(task.status), "INVALID_TRANSITION", `Task is ${task.status}`);
    return task;
  }
  #running(input: TaskActor): Task {
    const task = this.#editable(input);
    this.ctx.read.liveAgent(input.runId, input.agentId);
    invariant(task.status === "running", "INVALID_TRANSITION", "Task must be running");
    invariant(task.assigneeId === input.agentId, "INVALID_TRANSITION", "Only the assigned agent may act on this task");
    return task;
  }
  create(input: CreateTask): Task {
    return this.ctx.command(emit => {
      this.ctx.read.activeRun(input.runId);
      const title = text(input.title, "title", 256);
      const description = text(input.description ?? "", "description", 4096, true);
      const expectedOutput = text(input.expectedOutput ?? "", "expectedOutput", 4096, true);
      const data = jsonObject(input.input ?? {}, "input");
      const dependencies = uniqueIds(input.dependencyIds, "dependencyIds");
      const artifacts = uniqueIds(input.inputArtifactIds, "inputArtifactIds");
      for (const id of dependencies) this.ctx.read.task(input.runId, id);
      for (const id of artifacts) this.ctx.read.artifact(input.runId, id);
      const id = newId("task");
      const now = new Date().toISOString();
      this.ctx.db.execute(`INSERT INTO tasks(id, run_id, title, description, expected_output, status, input_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`, id, input.runId, title, description, expectedOutput, JSON.stringify(data), now, now);
      for (const dependencyId of dependencies) insertDependency(this.ctx, input.runId, id, dependencyId);
      for (const artifactId of artifacts) this.ctx.db.execute("INSERT INTO task_artifacts(run_id, task_id, artifact_id, direction) VALUES (?, ?, ?, 'input')", input.runId, id, artifactId);
      emit(input.runId, "task.created", { taskId: id, status: "pending" });
      for (const dependencyId of dependencies) emit(input.runId, "task.dependency_added", { taskId: id, dependsOnTaskId: dependencyId });
      reconcileDependencies(this.ctx, emit, input.runId);
      return this.ctx.read.task(input.runId, id);
    });
  }
  assign(input: TaskActor): Task {
    return this.ctx.command(emit => {
      const task = this.#editable(input);
      this.ctx.read.liveAgent(input.runId, input.agentId);
      invariant(task.status !== "running", "INVALID_TRANSITION", "Block a running task before handing it off");
      invariant(task.assigneeId !== input.agentId, "INVALID_TRANSITION", "Task is already assigned to this agent");
      this.ctx.db.execute("UPDATE tasks SET assignee_id = ?, updated_at = ? WHERE id = ?", input.agentId, new Date().toISOString(), task.id);
      emit(input.runId, "task.assigned", { taskId: task.id, agentId: input.agentId, previousAgentId: task.assigneeId });
      return this.ctx.read.task(input.runId, task.id);
    });
  }
  start(input: TaskActor): Task {
    return this.ctx.command(emit => {
      const task = this.#editable(input);
      const agent = this.ctx.read.liveAgent(input.runId, input.agentId);
      invariant(task.status === "ready", "INVALID_TRANSITION", `Only ready tasks can start, found ${task.status}`);
      invariant(task.assigneeId === input.agentId, "INVALID_TRANSITION", "Task must be assigned to the executing agent");
      invariant(agent.currentTaskId === null, "AGENT_BUSY", "Agent already has a running task");
      const now = new Date().toISOString();
      this.ctx.db.execute("UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?", now, now, task.id);
      emit(input.runId, "task.started", { taskId: task.id, agentId: input.agentId });
      return this.ctx.read.task(input.runId, task.id);
    });
  }
  complete(input: TaskActor & { outputArtifactIds?: readonly ArtifactId[] }): Task {
    return this.ctx.command(emit => {
      const task = this.#running(input);
      const outputs = uniqueIds(input.outputArtifactIds, "outputArtifactIds");
      for (const id of outputs) {
        const artifact = this.ctx.read.artifact(input.runId, id);
        invariant(artifact.taskId === task.id, "VALIDATION", "Task outputs must have been produced for this task");
      }
      for (const artifactId of outputs) this.ctx.db.execute("INSERT INTO task_artifacts(run_id, task_id, artifact_id, direction) VALUES (?, ?, ?, 'output')", input.runId, task.id, artifactId);
      const now = new Date().toISOString();
      this.ctx.db.execute("UPDATE tasks SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ?", now, now, task.id);
      emit(input.runId, "task.completed", { taskId: task.id, agentId: input.agentId, outputArtifactIds: outputs });
      reconcileDependencies(this.ctx, emit, input.runId);
      settleRun(this.ctx, emit, input.runId);
      return this.ctx.read.task(input.runId, task.id);
    });
  }
  fail(input: TaskActor & { reason: string }): Task {
    return this.ctx.command(emit => {
      const task = this.#running(input);
      const reason = text(input.reason, "reason");
      const now = new Date().toISOString();
      this.ctx.db.execute("UPDATE tasks SET status = 'failed', failure_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?", reason, now, now, task.id);
      emit(input.runId, "task.failed", { taskId: task.id, agentId: input.agentId, reason });
      reconcileDependencies(this.ctx, emit, input.runId);
      settleRun(this.ctx, emit, input.runId);
      return this.ctx.read.task(input.runId, task.id);
    });
  }
  cancel(input: TaskRef & { reason: string }): Task {
    return this.ctx.command(emit => {
      const task = this.#editable(input);
      cancelTask(this.ctx, emit, task, text(input.reason, "reason"));
      reconcileDependencies(this.ctx, emit, input.runId);
      settleRun(this.ctx, emit, input.runId);
      return this.ctx.read.task(input.runId, task.id);
    });
  }
  block(input: TaskActor & { reason: string }): Task {
    return this.ctx.command(emit => {
      const task = this.#running(input);
      const reason = text(input.reason, "reason");
      this.ctx.db.execute("UPDATE tasks SET status = 'blocked', block_kind = 'manual', block_reason = ?, updated_at = ? WHERE id = ?", reason, new Date().toISOString(), task.id);
      emit(input.runId, "task.blocked", { taskId: task.id, kind: "manual", reason });
      reconcileDependencies(this.ctx, emit, input.runId);
      return this.ctx.read.task(input.runId, task.id);
    });
  }
  unblock(input: TaskRef): Task {
    return this.ctx.command(emit => {
      const task = this.#editable(input);
      invariant(task.status === "blocked" && task.blockKind === "manual", "INVALID_TRANSITION", "Only manual blocks can be explicitly removed");
      this.ctx.db.execute("UPDATE tasks SET status = 'pending', block_kind = NULL, block_reason = NULL, updated_at = ? WHERE id = ?", new Date().toISOString(), task.id);
      emit(input.runId, "task.unblocked", { taskId: task.id });
      reconcileDependencies(this.ctx, emit, input.runId);
      return this.ctx.read.task(input.runId, task.id);
    });
  }
  addDependency(input: TaskRef & { dependsOnTaskId: TaskId }): Task {
    return this.ctx.command(emit => {
      assertDependenciesEditable(this.#editable(input));
      insertDependency(this.ctx, input.runId, input.taskId, input.dependsOnTaskId);
      this.ctx.db.execute("UPDATE tasks SET updated_at = ? WHERE id = ?", new Date().toISOString(), input.taskId);
      emit(input.runId, "task.dependency_added", { taskId: input.taskId, dependsOnTaskId: input.dependsOnTaskId });
      reconcileDependencies(this.ctx, emit, input.runId);
      return this.ctx.read.task(input.runId, input.taskId);
    });
  }
  removeDependency(input: TaskRef & { dependsOnTaskId: TaskId }): Task {
    return this.ctx.command(emit => {
      assertDependenciesEditable(this.#editable(input));
      this.ctx.read.task(input.runId, input.dependsOnTaskId);
      const result = this.ctx.db.execute("DELETE FROM task_dependencies WHERE run_id = ? AND task_id = ? AND depends_on_task_id = ?", input.runId, input.taskId, input.dependsOnTaskId);
      invariant(result.changes === 1, "NOT_FOUND", "Dependency not found");
      this.ctx.db.execute("UPDATE tasks SET updated_at = ? WHERE id = ?", new Date().toISOString(), input.taskId);
      emit(input.runId, "task.dependency_removed", { taskId: input.taskId, dependsOnTaskId: input.dependsOnTaskId });
      reconcileDependencies(this.ctx, emit, input.runId);
      return this.ctx.read.task(input.runId, input.taskId);
    });
  }
}
