import type { AgentId, ArtifactId, MessageId, RunId, TaskId, WorkspaceId } from "./ids.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type TaskStatus = "pending" | "ready" | "running" | "blocked" | "completed" | "failed" | "cancelled";
export type RunStatus = "active" | "completed" | "failed" | "cancelled";
export type MessageType = "request_info" | "response" | "feedback" | "review_request" | "notification";

export interface Workspace { id: WorkspaceId; name: string; createdAt: string }
export interface OrganizationRun {
  id: RunId; workspaceId: WorkspaceId; name: string; status: RunStatus;
  createdAt: string; endedAt: string | null;
}
export interface Task {
  id: TaskId; runId: RunId; title: string; description: string; expectedOutput: string;
  status: TaskStatus; assigneeId: AgentId | null; input: JsonObject;
  inputArtifactIds: ArtifactId[]; outputArtifactIds: ArtifactId[]; dependencyIds: TaskId[];
  blockKind: "manual" | "dependency" | null; blockReason: string | null;
  failureReason: string | null; cancellationReason: string | null;
  createdAt: string; updatedAt: string; startedAt: string | null; endedAt: string | null;
}
export interface TaskDependency { runId: RunId; taskId: TaskId; dependsOnTaskId: TaskId }
export interface AgentInstance {
  id: AgentId; runId: RunId; name: string; role: string;
  status: "idle" | "busy" | "terminated"; currentTaskId: TaskId | null; assignedTaskIds: TaskId[];
  createdAt: string; terminatedAt: string | null;
}
export interface Message {
  id: MessageId; runId: RunId; senderId: AgentId; recipientId: AgentId;
  taskId: TaskId | null; type: MessageType; body: string; artifactIds: ArtifactId[]; createdAt: string;
}
export interface Artifact {
  id: ArtifactId; runId: RunId; taskId: TaskId; producerAgentId: AgentId;
  name: string; mediaType: string; relativePath: string; byteLength: number; sha256: string;
  metadata: JsonObject; createdAt: string;
}
