import type { AgentId, ArtifactId, EventId, MessageId, RunId, TaskId } from "./ids.js";
import type { MessageType, TaskStatus } from "./models.js";

export interface EventPayloads {
  "run.created": { name: string };
  "run.completed": Record<string, never>;
  "run.failed": Record<string, never>;
  "run.cancelled": { reason: string };
  "task.created": { taskId: TaskId; status: TaskStatus };
  "task.assigned": { taskId: TaskId; agentId: AgentId; previousAgentId: AgentId | null };
  "task.dependency_added": { taskId: TaskId; dependsOnTaskId: TaskId };
  "task.dependency_removed": { taskId: TaskId; dependsOnTaskId: TaskId };
  "task.pending": { taskId: TaskId; previousStatus: TaskStatus };
  "task.ready": { taskId: TaskId; previousStatus: TaskStatus };
  "task.started": { taskId: TaskId; agentId: AgentId };
  "task.blocked": { taskId: TaskId; kind: "manual" | "dependency"; reason: string };
  "task.unblocked": { taskId: TaskId };
  "task.completed": { taskId: TaskId; agentId: AgentId; outputArtifactIds: ArtifactId[] };
  "task.failed": { taskId: TaskId; agentId: AgentId; reason: string };
  "task.cancelled": { taskId: TaskId; reason: string };
  "agent.created": { agentId: AgentId; role: string };
  "agent.terminated": { agentId: AgentId };
  "message.sent": { messageId: MessageId; senderId: AgentId; recipientId: AgentId; type: MessageType; artifactIds: ArtifactId[] };
  "artifact.created": { artifactId: ArtifactId; taskId: TaskId; producerAgentId: AgentId };
}
export type EventType = keyof EventPayloads;
export type RuntimeEvent<K extends EventType = EventType> = {
  [P in K]: { id: EventId; sequence: number; runId: RunId; type: P; payload: EventPayloads[P]; occurredAt: string }
}[K];
export type EventListener<K extends EventType = EventType> = (event: RuntimeEvent<K>) => void | Promise<void>;
