import { newId, type AgentId, type RunId } from "../../shared/ids.js";
import { text } from "../../shared/validation.js";
import type { AgentInstance } from "../../shared/models.js";
import type { RuntimeContext } from "../context.js";
import { terminateAgent } from "./lifecycle.js";

export class AgentService {
  constructor(private readonly ctx: RuntimeContext) {}
  spawn(input: { runId: RunId; name: string; role: string }): AgentInstance {
    return this.ctx.command(emit => {
      this.ctx.read.activeRun(input.runId);
      const name = text(input.name, "name", 256);
      const role = text(input.role, "role", 256);
      const id = newId("agent");
      this.ctx.db.execute("INSERT INTO agent_instances(id, run_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)", id, input.runId, name, role, new Date().toISOString());
      emit(input.runId, "agent.created", { agentId: id, role });
      return this.ctx.read.agent(input.runId, id);
    });
  }
  terminate(input: { runId: RunId; agentId: AgentId }): AgentInstance {
    return this.ctx.command(emit => {
      this.ctx.read.activeRun(input.runId);
      terminateAgent(this.ctx, emit, input.runId, input.agentId);
      return this.ctx.read.agent(input.runId, input.agentId);
    });
  }
}
