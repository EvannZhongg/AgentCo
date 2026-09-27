import { invariant } from "../../shared/errors.js";
import type { RunId, TaskId } from "../../shared/ids.js";
import type { Task, TaskStatus } from "../../shared/models.js";
import type { Emit, RuntimeContext } from "../context.js";
import { isTerminal } from "./lifecycle.js";

export function assertDependenciesEditable(task: Task): void {
  invariant(task.startedAt === null && !isTerminal(task.status), "INVALID_TRANSITION", "Dependencies are immutable once a task has started or ended");
}

export function insertDependency(ctx: RuntimeContext, runId: RunId, taskId: TaskId, dependsOnTaskId: TaskId): void {
  ctx.read.task(runId, dependsOnTaskId);
  invariant(taskId !== dependsOnTaskId, "DEPENDENCY_CYCLE", "A task cannot depend on itself");
  invariant(!ctx.db.get("SELECT 1 FROM task_dependencies WHERE run_id = ? AND task_id = ? AND depends_on_task_id = ?", runId, taskId, dependsOnTaskId), "VALIDATION", "Dependency already exists");
  const cycle = ctx.db.get(`WITH RECURSIVE ancestors(id) AS (
    SELECT ? UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN ancestors a ON d.task_id = a.id WHERE d.run_id = ?
  ) SELECT 1 FROM ancestors WHERE id = ?`, dependsOnTaskId, runId, taskId);
  invariant(!cycle, "DEPENDENCY_CYCLE", "Dependency would create a cycle");
  ctx.db.execute("INSERT INTO task_dependencies(run_id, task_id, depends_on_task_id) VALUES (?, ?, ?)", runId, taskId, dependsOnTaskId);
}

// Fixed-point projection over the persisted DAG. Only unstarted/waiting work is eligible.
// Manual blocks are authoritative until task.unblock; dependency blocks follow their edges.
export function reconcileDependencies(ctx: RuntimeContext, emit: Emit, runId: RunId): void {
  let changed: boolean;
  do {
    changed = false;
    const waiting = ctx.db.all<{ id: TaskId; status: TaskStatus; blockKind: string | null; blockReason: string | null }>(
      "SELECT id, status, block_kind AS blockKind, block_reason AS blockReason FROM tasks WHERE run_id = ? AND status IN ('pending','ready','blocked') ORDER BY rowid", runId,
    );
    for (const task of waiting) {
      if (task.blockKind === "manual") continue;
      const dependencies = ctx.db.all<{ id: TaskId; status: TaskStatus }>(
        "SELECT t.id, t.status FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id AND t.run_id = d.run_id WHERE d.run_id = ? AND d.task_id = ? ORDER BY d.rowid", runId, task.id,
      );
      const unavailable = dependencies.find(dependency => ["failed", "cancelled", "blocked"].includes(dependency.status));
      const status = unavailable ? "blocked" : dependencies.every(dependency => dependency.status === "completed") ? "ready" : "pending";
      const reason = unavailable ? `Dependency ${unavailable.id} is ${unavailable.status}` : null;
      if (task.status === status && task.blockReason === reason) continue;
      ctx.db.execute("UPDATE tasks SET status = ?, block_kind = ?, block_reason = ?, updated_at = ? WHERE id = ?", status, status === "blocked" ? "dependency" : null, reason, new Date().toISOString(), task.id);
      if (status === "blocked") emit(runId, "task.blocked", { taskId: task.id, kind: "dependency", reason: reason! });
      else if (status === "ready") emit(runId, "task.ready", { taskId: task.id, previousStatus: task.status });
      else emit(runId, "task.pending", { taskId: task.id, previousStatus: task.status });
      changed = true;
    }
  } while (changed);
}
