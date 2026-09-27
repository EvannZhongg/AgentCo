import { invariant } from "./errors.js";
import type { JsonObject, JsonValue } from "./models.js";

export function text(value: unknown, field: string, maxBytes = 4096, allowEmpty = false): string {
  invariant(typeof value === "string", "VALIDATION", `${field} must be a string`);
  invariant(allowEmpty || value.trim().length > 0, "VALIDATION", `${field} must not be empty`);
  invariant(Buffer.byteLength(value) <= maxBytes, "VALIDATION", `${field} exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}

export function jsonObject(value: unknown, field: string, maxBytes = 8192): JsonObject {
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): asserts item is JsonValue {
    invariant(depth <= 32, "VALIDATION", `${field} is too deeply nested`);
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      invariant(Number.isFinite(item), "VALIDATION", `${field} contains a non-finite number`);
      return;
    }
    invariant(typeof item === "object", "VALIDATION", `${field} must contain JSON values only`);
    invariant(!seen.has(item), "VALIDATION", `${field} contains a cycle`);
    invariant(Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, "VALIDATION", `${field} must contain plain JSON objects`);
    seen.add(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
    seen.delete(item);
  }
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "VALIDATION", `${field} must be an object`);
  visit(value, 0);
  const serialized = JSON.stringify(value);
  invariant(Buffer.byteLength(serialized) <= maxBytes, "VALIDATION", `${field} exceeds ${maxBytes} UTF-8 bytes; use an Artifact`);
  return JSON.parse(serialized) as JsonObject;
}

export function uniqueIds<T extends string>(value: readonly T[] | undefined, field: string): T[] {
  if (value === undefined) return [];
  invariant(Array.isArray(value) && value.length <= 1000, "VALIDATION", `${field} must be an array of at most 1000 IDs`);
  for (const id of value) text(id, field, 100);
  invariant(new Set(value).size === value.length, "VALIDATION", `${field} contains duplicate IDs`);
  return [...value];
}
