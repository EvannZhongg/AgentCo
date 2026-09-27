import type { ArtifactFiles } from "../../persistence/files/artifact-files.js";
import { invariant } from "../../shared/errors.js";
import { newId, type AgentId, type ArtifactId, type RunId, type TaskId } from "../../shared/ids.js";
import type { Artifact, JsonObject } from "../../shared/models.js";
import { jsonObject, text } from "../../shared/validation.js";
import type { RuntimeContext } from "../context.js";

export interface CreateArtifact {
  runId: RunId; taskId: TaskId; producerAgentId: AgentId; name: string; mediaType: string;
  content: string | Uint8Array; metadata?: JsonObject;
}
export interface ResolveArtifact { runId: RunId; artifactId: ArtifactId; readerAgentId: AgentId }
export class ArtifactService {
  constructor(private readonly ctx: RuntimeContext, private readonly files: ArtifactFiles) {}
  create(input: CreateArtifact): Artifact {
    let writtenPath: string | undefined;
    try {
      return this.ctx.command(emit => {
        this.ctx.read.activeRun(input.runId);
        const task = this.ctx.read.task(input.runId, input.taskId);
        this.ctx.read.liveAgent(input.runId, input.producerAgentId);
        invariant(task.status === "running" && task.assigneeId === input.producerAgentId, "INVALID_TRANSITION", "Artifact producer must be executing the associated task");
        const name = text(input.name, "name", 256);
        const mediaType = text(input.mediaType, "mediaType", 256);
        const metadata = jsonObject(input.metadata ?? {}, "metadata");
        const id = newId("artifact");
        const file = this.files.write(input.runId, id, input.content);
        writtenPath = file.relativePath;
        this.ctx.db.execute(`INSERT INTO artifacts(id, run_id, task_id, producer_agent_id, name, media_type, relative_path, byte_length, sha256, metadata_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, input.runId, input.taskId, input.producerAgentId, name, mediaType, file.relativePath, file.byteLength, file.sha256, JSON.stringify(metadata), new Date().toISOString());
        emit(input.runId, "artifact.created", { artifactId: id, taskId: input.taskId, producerAgentId: input.producerAgentId });
        return this.ctx.read.artifact(input.runId, id);
      });
    } catch (error) {
      // A failed SQL transaction must not leave its staged file behind.
      if (writtenPath) {
        try { this.files.remove(writtenPath); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Artifact transaction and content cleanup both failed");
        }
      }
      throw error;
    }
  }
  resolve(input: ResolveArtifact): { artifact: Artifact; content: Buffer } {
    // Historical agents may read results after automatic run teardown; this is a scope check, not authentication.
    this.ctx.read.agent(input.runId, input.readerAgentId);
    const artifact = this.ctx.read.artifact(input.runId, input.artifactId);
    return { artifact, content: this.files.read(artifact.relativePath, artifact.byteLength, artifact.sha256) };
  }
}
