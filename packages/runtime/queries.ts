import type { SqliteDatabase } from "../persistence/sqlite/database.js";
import { invariant } from "../shared/errors.js";
import type { AgentId, ArtifactId, MessageId, RunId, TaskId, WorkspaceId } from "../shared/ids.js";
import type { AgentInstance, Artifact, Message, OrganizationRun, Task, TaskDependency, Workspace } from "../shared/models.js";

const workspaceColumns = "id, name, created_at AS createdAt";
const runColumns = "id, workspace_id AS workspaceId, name, status, created_at AS createdAt, ended_at AS endedAt";
const taskColumns = `id, run_id AS runId, title, description, expected_output AS expectedOutput, status,
  assignee_id AS assigneeId, input_json AS inputJson, block_kind AS blockKind, block_reason AS blockReason,
  failure_reason AS failureReason, cancellation_reason AS cancellationReason,
  created_at AS createdAt, updated_at AS updatedAt, started_at AS startedAt, ended_at AS endedAt`;
const agentColumns = "id, run_id AS runId, name, role, created_at AS createdAt, terminated_at AS terminatedAt";
const artifactColumns = `id, run_id AS runId, task_id AS taskId, producer_agent_id AS producerAgentId,
  name, media_type AS mediaType, relative_path AS relativePath, byte_length AS byteLength, sha256,
  metadata_json AS metadataJson, created_at AS createdAt`;
const messageColumns = `id, run_id AS runId, sender_id AS senderId, recipient_id AS recipientId,
  task_id AS taskId, type, body, created_at AS createdAt`;

type TaskRow = Omit<Task, "input" | "dependencyIds" | "inputArtifactIds" | "outputArtifactIds"> & { inputJson: string };
type AgentRow = Omit<AgentInstance, "status" | "currentTaskId" | "assignedTaskIds">;
type ArtifactRow = Omit<Artifact, "metadata"> & { metadataJson: string };
type MessageRow = Omit<Message, "artifactIds">;

function scoped<T extends { runId: RunId }>(row: T | undefined, runId: RunId, label: string): T {
  invariant(row, "NOT_FOUND", `${label} not found`);
  invariant(row.runId === runId, "RUN_SCOPE", `${label} belongs to another run`);
  return row;
}

// SQL projections, not a second state store. Every returned object is a detached snapshot.
export class Queries {
  constructor(private readonly db: SqliteDatabase) {}
  workspace(id: WorkspaceId): Workspace {
    const row = this.db.get<Workspace>(`SELECT ${workspaceColumns} FROM workspaces WHERE id = ?`, id);
    invariant(row, "NOT_FOUND", "Workspace not found");
    return { ...row };
  }
  workspaces(): Workspace[] { return this.db.all<Workspace>(`SELECT ${workspaceColumns} FROM workspaces ORDER BY rowid`).map(row => ({ ...row })); }
  run(id: RunId): OrganizationRun {
    const row = this.db.get<OrganizationRun>(`SELECT ${runColumns} FROM runs WHERE id = ?`, id);
    invariant(row, "NOT_FOUND", "OrganizationRun not found");
    return { ...row };
  }
  activeRun(id: RunId): OrganizationRun {
    const run = this.run(id);
    invariant(run.status === "active", "INVALID_TRANSITION", `Run is ${run.status}`);
    return run;
  }
  runs(workspaceId: WorkspaceId): OrganizationRun[] {
    this.workspace(workspaceId);
    return this.db.all<OrganizationRun>(`SELECT ${runColumns} FROM runs WHERE workspace_id = ? ORDER BY rowid`, workspaceId).map(row => ({ ...row }));
  }
  #task(row: TaskRow): Task {
    const { inputJson, ...rest } = row;
    const refs = this.db.all<{ artifactId: ArtifactId; direction: string }>("SELECT artifact_id AS artifactId, direction FROM task_artifacts WHERE run_id = ? AND task_id = ? ORDER BY rowid", row.runId, row.id);
    return {
      ...rest, input: JSON.parse(inputJson),
      dependencyIds: this.db.all<{ id: TaskId }>("SELECT depends_on_task_id AS id FROM task_dependencies WHERE run_id = ? AND task_id = ? ORDER BY rowid", row.runId, row.id).map(item => item.id),
      inputArtifactIds: refs.filter(ref => ref.direction === "input").map(ref => ref.artifactId),
      outputArtifactIds: refs.filter(ref => ref.direction === "output").map(ref => ref.artifactId),
    };
  }
  task(runId: RunId, id: TaskId): Task {
    return this.#task(scoped(this.db.get<TaskRow>(`SELECT ${taskColumns} FROM tasks WHERE id = ?`, id), runId, "Task"));
  }
  tasks(runId: RunId): Task[] {
    this.run(runId);
    return this.db.all<TaskRow>(`SELECT ${taskColumns} FROM tasks WHERE run_id = ? ORDER BY rowid`, runId).map(row => this.#task(row));
  }
  dependencies(runId: RunId): TaskDependency[] {
    this.run(runId);
    return this.db.all<TaskDependency>("SELECT run_id AS runId, task_id AS taskId, depends_on_task_id AS dependsOnTaskId FROM task_dependencies WHERE run_id = ? ORDER BY rowid", runId).map(row => ({ ...row }));
  }
  #agent(row: AgentRow): AgentInstance {
    const tasks = this.db.all<{ id: TaskId; status: string }>("SELECT id, status FROM tasks WHERE run_id = ? AND assignee_id = ? AND status NOT IN ('completed','failed','cancelled') ORDER BY rowid", row.runId, row.id);
    const currentTaskId = tasks.find(task => task.status === "running")?.id ?? null;
    return { ...row, status: row.terminatedAt ? "terminated" : currentTaskId ? "busy" : "idle", currentTaskId, assignedTaskIds: tasks.map(task => task.id) };
  }
  agent(runId: RunId, id: AgentId): AgentInstance {
    return this.#agent(scoped(this.db.get<AgentRow>(`SELECT ${agentColumns} FROM agent_instances WHERE id = ?`, id), runId, "Agent"));
  }
  liveAgent(runId: RunId, id: AgentId): AgentInstance {
    const agent = this.agent(runId, id);
    invariant(agent.status !== "terminated", "INVALID_TRANSITION", "Agent is terminated");
    return agent;
  }
  agents(runId: RunId): AgentInstance[] {
    this.run(runId);
    return this.db.all<AgentRow>(`SELECT ${agentColumns} FROM agent_instances WHERE run_id = ? ORDER BY rowid`, runId).map(row => this.#agent(row));
  }
  artifact(runId: RunId, id: ArtifactId): Artifact {
    const { metadataJson, ...row } = scoped(this.db.get<ArtifactRow>(`SELECT ${artifactColumns} FROM artifacts WHERE id = ?`, id), runId, "Artifact");
    return { ...row, metadata: JSON.parse(metadataJson) };
  }
  artifacts(runId: RunId, taskId?: TaskId): Artifact[] {
    this.run(runId);
    if (taskId) this.task(runId, taskId);
    return this.db.all<{ id: ArtifactId }>("SELECT id FROM artifacts WHERE run_id = ? AND (? IS NULL OR task_id = ?) ORDER BY rowid", runId, taskId ?? null, taskId ?? null).map(row => this.artifact(runId, row.id));
  }
  message(runId: RunId, id: MessageId): Message {
    const row = scoped(this.db.get<MessageRow>(`SELECT ${messageColumns} FROM messages WHERE id = ?`, id), runId, "Message");
    const artifactIds = this.db.all<{ id: ArtifactId }>("SELECT artifact_id AS id FROM message_artifacts WHERE run_id = ? AND message_id = ? ORDER BY rowid", runId, id).map(ref => ref.id);
    return { ...row, artifactIds };
  }
  messages(runId: RunId, recipientId?: AgentId): Message[] {
    this.run(runId);
    if (recipientId) this.agent(runId, recipientId);
    return this.db.all<{ id: MessageId }>("SELECT id FROM messages WHERE run_id = ? AND (? IS NULL OR recipient_id = ?) ORDER BY rowid", runId, recipientId ?? null, recipientId ?? null).map(row => this.message(runId, row.id));
  }
}
