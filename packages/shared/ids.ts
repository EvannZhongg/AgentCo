import { randomUUID } from "node:crypto";

declare const brand: unique symbol;
export type Id<Kind extends string> = string & { readonly [brand]: Kind };
export type WorkspaceId = Id<"workspace">;
export type RunId = Id<"run">;
export type TaskId = Id<"task">;
export type AgentId = Id<"agent">;
export type MessageId = Id<"message">;
export type ArtifactId = Id<"artifact">;
export type EventId = Id<"event">;

export function newId<K extends string>(kind: K): Id<K> {
  return `${kind}_${randomUUID()}` as Id<K>;
}
