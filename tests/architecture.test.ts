import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("package dependencies point downward, contain no cycles and expose one runtime facade", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages");
  function files(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
    });
  }
  const dependencies = new Map<string, string[]>();
  const rank: Record<string, number> = { shared: 0, persistence: 1, runtime: 2 };
  for (const path of files(root)) {
    const layer = relative(root, path).split(/[\\/]/)[0]!;
    const imports = [...readFileSync(path, "utf8").matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map(match => match[1]!);
    const local: string[] = [];
    for (const specifier of imports) {
      if (!specifier.startsWith(".")) {
        assert.ok(specifier.startsWith("node:"), `Unexpected provider/library dependency: ${specifier}`);
        continue;
      }
      const target = resolve(dirname(path), specifier.replace(/\.js$/, ".ts"));
      assert.ok(existsSync(target), `Missing import: ${target}`);
      const dependencyLayer = relative(root, target).split(/[\\/]/)[0]!;
      assert.ok(rank[dependencyLayer]! <= rank[layer]!, `Upward dependency: ${path} -> ${target}`);
      local.push(target);
    }
    dependencies.set(path, local);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(path: string): void {
    assert.ok(!visiting.has(path), `Dependency cycle at ${path}`);
    if (visited.has(path)) return;
    visiting.add(path);
    for (const dependency of dependencies.get(path) ?? []) visit(dependency);
    visiting.delete(path);
    visited.add(path);
  }
  for (const path of dependencies.keys()) visit(path);
  const pkg = JSON.parse(readFileSync(resolve(root, "../package.json"), "utf8")) as { exports: Record<string, unknown> };
  assert.deepEqual(Object.keys(pkg.exports), ["."]);
});
