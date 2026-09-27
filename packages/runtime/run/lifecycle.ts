import type { RunId } from "../../shared/ids.js";
import type { TaskStatus } from "../../shared/models.js";
import type { Emit, RuntimeContext } from "../context.js";
import { terminateAgent } from "../agent/lifecycle.js";
import { isTerminal } from "../task/lifecycle.js";

type RunOutcome = { status: "completed" | "failed" } | { status: "cancelled"; reason: string };

export function finishRun(ctx: RuntimeContext, emit: Emit, runId: RunId, outcome: RunOutcome): void {
  ctx.db.execute("UPDATE runs SET status = ?, ended_at = ? WHERE id = ?", outcome.status, new Date().toISOString(), runId);
  for (const agent of ctx.read.agents(runId)) {
    if (agent.status !== "terminated") terminateAgent(ctx, emit, runId, agent.id);
  }
  if (outcome.status === "cancelled") emit(runId, "run.cancelled", { reason: outcome.reason });
  else if (outcome.status === "failed") emit(runId, "run.failed", {});
  else emit(runId, "run.completed", {});
}

export function settleRun(ctx: RuntimeContext, emit: Emit, runId: RunId): void {
  const statuses = ctx.db.all<{ status: TaskStatus }>("SELECT status FROM tasks WHERE run_id = ? ORDER BY rowid", runId).map(row => row.status);
  if (statuses.length === 0 || statuses.some(status => !isTerminal(status))) return;
  const status = statuses.includes("failed") ? "failed" : statuses.includes("cancelled") ? "cancelled" : "completed";
  finishRun(ctx, emit, runId, status === "cancelled" ? { status, reason: "One or more tasks were cancelled" } : { status });
}
