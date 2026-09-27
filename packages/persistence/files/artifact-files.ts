import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { RuntimeError, invariant } from "../../shared/errors.js";
import type { ArtifactId, RunId } from "../../shared/ids.js";

export class ArtifactFiles {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true }); }
  path(relativePath: string): string {
    const path = resolve(this.root, relativePath);
    const rel = relative(this.root, path);
    invariant(rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`), "ARTIFACT_IO", "Artifact path escapes its store");
    return path;
  }
  write(runId: RunId, artifactId: ArtifactId, content: string | Uint8Array): { relativePath: string; byteLength: number; sha256: string } {
    invariant(typeof content === "string" || content instanceof Uint8Array, "VALIDATION", "Artifact content must be a string or Uint8Array");
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const relativePath = `${runId}/${artifactId}.bin`;
    const path = this.path(relativePath);
    const temp = `${path}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(temp, "wx");
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
    } catch (cause) {
      rmSync(temp, { force: true });
      throw new RuntimeError("ARTIFACT_IO", "Could not persist artifact content", { cause });
    }
    return { relativePath, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  remove(relativePath: string): void { rmSync(this.path(relativePath), { force: true }); }
  read(relativePath: string, byteLength: number, sha256: string): Buffer {
    let content: Buffer;
    try { content = readFileSync(this.path(relativePath)); } catch (cause) {
      throw new RuntimeError("ARTIFACT_IO", "Artifact content is unavailable", { cause });
    }
    invariant(content.byteLength === byteLength && createHash("sha256").update(content).digest("hex") === sha256, "ARTIFACT_CORRUPT", "Artifact content does not match its persisted metadata");
    return content;
  }
}
