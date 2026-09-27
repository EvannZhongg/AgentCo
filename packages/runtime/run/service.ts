import { newId, type RunId, type WorkspaceId } from "../../shared/ids.js";
import { text } from "../../shared/validation.js";
import type { OrganizationRun, Workspace } from "../../shared/models.js";
import type { RuntimeContext } from "../context.js";
import { cancelTask, isTerminal } from "../task/lifecycle.js";
import { finishRun } from "./lifecycle.js";

export class WorkspaceService {
  constructor(private readonly ctx: RuntimeContext) {}
  create(input: { name: string }): Workspace {
    return this.ctx.command(() => {
      const name = text(input.name, "name", 256);
      const id = newId("workspace");
      this.ctx.db.execute("INSERT INTO workspaces(id, name, created_at) VALUES (?, ?, ?)", id, name, new Date().toISOString());
      return this.ctx.read.workspace(id);
    });
  }
}
export class RunService {
  constructor(private readonly ctx: RuntimeContext) {}
  create(input: { workspaceId: WorkspaceId; name: string }): OrganizationRun {
    return this.ctx.command(emit => {
      this.ctx.read.workspace(input.workspaceId);
      const name = text(input.name, "name", 256);
      const id = newId("run");
      this.ctx.db.execute("INSERT INTO runs(id, workspace_id, name, status, created_at) VALUES (?, ?, ?, 'active', ?)", id, input.workspaceId, name, new Date().toISOString());
      emit(id, "run.created", { name });
      return this.ctx.read.run(id);
    });
  }
  cancel(input: { runId: RunId; reason: string }): OrganizationRun {
    return this.ctx.command(emit => {
      this.ctx.read.activeRun(input.runId);
      const reason = text(input.reason, "reason");
      for (const task of this.ctx.read.tasks(input.runId)) {
        if (!isTerminal(task.status)) cancelTask(this.ctx, emit, task, reason);
      }
      finishRun(this.ctx, emit, input.runId, { status: "cancelled", reason });
      return this.ctx.read.run(input.runId);
    });
  }
}
