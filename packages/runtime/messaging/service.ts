import { invariant } from "../../shared/errors.js";
import { newId, type AgentId, type ArtifactId, type RunId, type TaskId } from "../../shared/ids.js";
import type { Message, MessageType } from "../../shared/models.js";
import { text, uniqueIds } from "../../shared/validation.js";
import type { RuntimeContext } from "../context.js";

export interface SendMessage {
  runId: RunId; senderId: AgentId; recipientId: AgentId; taskId?: TaskId;
  type: MessageType; body: string; artifactIds?: readonly ArtifactId[];
}
export class MessageService {
  constructor(private readonly ctx: RuntimeContext) {}
  send(input: SendMessage): Message {
    return this.ctx.command(emit => {
      this.ctx.read.activeRun(input.runId);
      this.ctx.read.liveAgent(input.runId, input.senderId);
      this.ctx.read.liveAgent(input.runId, input.recipientId);
      if (input.taskId !== undefined) this.ctx.read.task(input.runId, input.taskId);
      invariant(["request_info", "response", "feedback", "review_request", "notification"].includes(input.type), "VALIDATION", "Unsupported message type");
      const body = text(input.body, "body", 4096);
      const artifactIds = uniqueIds(input.artifactIds, "artifactIds");
      for (const id of artifactIds) this.ctx.read.artifact(input.runId, id);
      const id = newId("message");
      this.ctx.db.execute(`INSERT INTO messages(id, run_id, sender_id, recipient_id, task_id, type, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, input.runId, input.senderId, input.recipientId, input.taskId ?? null, input.type, body, new Date().toISOString());
      for (const artifactId of artifactIds) this.ctx.db.execute("INSERT INTO message_artifacts(run_id, message_id, artifact_id) VALUES (?, ?, ?)", input.runId, id, artifactId);
      emit(input.runId, "message.sent", { messageId: id, senderId: input.senderId, recipientId: input.recipientId, type: input.type, artifactIds });
      return this.ctx.read.message(input.runId, id);
    });
  }
}
