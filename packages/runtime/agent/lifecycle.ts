import type { AgentId, RunId } from "../../shared/ids.js";
import { invariant } from "../../shared/errors.js";
import type { Emit, RuntimeContext } from "../context.js";

export function terminateAgent(ctx: RuntimeContext, emit: Emit, runId: RunId, agentId: AgentId): void {
  const agent = ctx.read.liveAgent(runId, agentId);
  invariant(agent.assignedTaskIds.length === 0, "AGENT_HAS_TASKS", "Reassign or cancel unfinished tasks before terminating their agent");
  ctx.db.execute("UPDATE agent_instances SET terminated_at = ? WHERE id = ?", new Date().toISOString(), agentId);
  emit(runId, "agent.terminated", { agentId });
}
