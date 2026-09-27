import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ArtifactFiles } from "../persistence/files/artifact-files.js";
import { SqliteDatabase } from "../persistence/sqlite/database.js";
import type { RunId } from "../shared/ids.js";
import { text } from "../shared/validation.js";
import { AgentService } from "./agent/service.js";
import { ArtifactService } from "./artifacts/service.js";
import { RuntimeContext } from "./context.js";
import { EventBus, type ListenerErrorHandler } from "./events/bus.js";
import { EventStore } from "./events/store.js";
import { MessageService } from "./messaging/service.js";
import { RunService, WorkspaceService } from "./run/service.js";
import { TaskService } from "./task/service.js";

export interface RuntimeOptions { dataDirectory: string; onListenerError?: ListenerErrorHandler }

export class OrganizationRuntime {
  readonly #db: SqliteDatabase;
  readonly #bus: EventBus;
  readonly workspace;
  readonly run;
  readonly task;
  readonly agent;
  readonly message;
  readonly artifact;
  readonly events;
  readonly graph;

  constructor(options: RuntimeOptions) {
    text(options.dataDirectory, "dataDirectory");
    const root = resolve(options.dataDirectory);
    mkdirSync(root, { recursive: true });
    const files = new ArtifactFiles(join(root, "artifacts"));
    this.#db = new SqliteDatabase(join(root, "runtime.sqlite"));
    this.#bus = new EventBus(options.onListenerError ?? ((error, event) => {
      process.emitWarning(`Listener for ${event.type} failed: ${String(error)}`);
    }));
    const eventStore = new EventStore(this.#db);
    const ctx = new RuntimeContext(this.#db, eventStore, this.#bus);
    const workspace = new WorkspaceService(ctx);
    const run = new RunService(ctx);
    const task = new TaskService(ctx);
    const agent = new AgentService(ctx);
    const message = new MessageService(ctx);
    const artifact = new ArtifactService(ctx, files);
    const read = ctx.read;
    this.workspace = Object.freeze({ create: workspace.create.bind(workspace), get: read.workspace.bind(read), list: read.workspaces.bind(read) });
    this.run = Object.freeze({ create: run.create.bind(run), get: read.run.bind(read), list: read.runs.bind(read), cancel: run.cancel.bind(run) });
    this.task = Object.freeze({
      create: task.create.bind(task), get: read.task.bind(read), list: read.tasks.bind(read),
      assign: task.assign.bind(task), start: task.start.bind(task), complete: task.complete.bind(task),
      fail: task.fail.bind(task), cancel: task.cancel.bind(task), block: task.block.bind(task), unblock: task.unblock.bind(task),
      addDependency: task.addDependency.bind(task), removeDependency: task.removeDependency.bind(task),
    });
    this.agent = Object.freeze({ spawn: agent.spawn.bind(agent), get: read.agent.bind(read), list: read.agents.bind(read), terminate: agent.terminate.bind(agent) });
    this.message = Object.freeze({ send: message.send.bind(message), get: read.message.bind(read), list: read.messages.bind(read) });
    this.artifact = Object.freeze({ create: artifact.create.bind(artifact), get: read.artifact.bind(read), list: read.artifacts.bind(read), resolve: artifact.resolve.bind(artifact) });
    this.events = Object.freeze({
      subscribe: this.#bus.subscribe.bind(this.#bus),
      list: (runId: RunId, afterSequence?: number, limit?: number) => { read.run(runId); return eventStore.list(runId, afterSequence, limit); },
    });
    this.graph = Object.freeze({
      tasks: (runId: RunId) => ({ tasks: read.tasks(runId), dependencies: read.dependencies(runId) }),
      agents: (runId: RunId) => ({
        agents: read.agents(runId),
        assignments: read.tasks(runId).filter(task => task.assigneeId !== null).map(task => ({ taskId: task.id, agentId: task.assigneeId! })),
      }),
      // No permission graph in phase one. This projects observed communication only.
      communications: (runId: RunId) => ({
        agents: read.agents(runId),
        messages: read.messages(runId).map(message => ({ messageId: message.id, senderId: message.senderId, recipientId: message.recipientId, taskId: message.taskId })),
      }),
    });
  }
  close(): void { this.#db.close(); this.#bus.close(); }
}
