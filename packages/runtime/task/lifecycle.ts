import type { Task, TaskStatus } from "../../shared/models.js";
import type { Emit, RuntimeContext } from "../context.js";

export const isTerminal = (status: TaskStatus): boolean => ["completed", "failed", "cancelled"].includes(status);

export function cancelTask(ctx: RuntimeContext, emit: Emit, task: Task, reason: string): void {
  const now = new Date().toISOString();
  ctx.db.execute("UPDATE tasks SET status = 'cancelled', block_kind = NULL, block_reason = NULL, cancellation_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?", reason, now, now, task.id);
  emit(task.runId, "task.cancelled", { taskId: task.id, reason });
}
