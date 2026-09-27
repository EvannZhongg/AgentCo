export type ErrorCode =
  | "VALIDATION" | "NOT_FOUND" | "RUN_SCOPE" | "INVALID_TRANSITION"
  | "DEPENDENCY_CYCLE" | "AGENT_BUSY" | "AGENT_HAS_TASKS"
  | "ARTIFACT_IO" | "ARTIFACT_CORRUPT" | "CLOSED" | "SCHEMA_VERSION";

export class RuntimeError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeError";
  }
}

export function invariant(condition: unknown, code: ErrorCode, message: string): asserts condition {
  if (!condition) throw new RuntimeError(code, message);
}
