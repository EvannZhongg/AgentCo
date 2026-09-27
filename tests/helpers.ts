import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { TestContext } from "node:test";
import { OrganizationRuntime, RuntimeError, type ErrorCode, type RuntimeOptions } from "../packages/runtime/index.js";

export function fixture(t: TestContext, options: Omit<RuntimeOptions, "dataDirectory"> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agentco-kernel-"));
  const runtime = new OrganizationRuntime({ dataDirectory: directory, ...options });
  t.after(() => {
    runtime.close();
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(`${resolve(tmpdir())}${sep}agentco-kernel-`));
    rmSync(absolute, { recursive: true, force: true });
  });
  const workspace = runtime.workspace.create({ name: "Test workspace" });
  const run = runtime.run.create({ workspaceId: workspace.id, name: "Test organization" });
  const a = runtime.agent.spawn({ runId: run.id, name: "A", role: "producer" });
  const b = runtime.agent.spawn({ runId: run.id, name: "B", role: "reviewer" });
  return { runtime, directory, workspace, run, a, b };
}

export function rejects(code: ErrorCode, operation: () => unknown): void {
  assert.throws(operation, error => error instanceof RuntimeError && error.code === code);
}
