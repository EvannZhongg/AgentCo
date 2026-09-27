import type { SqliteDatabase } from "../../persistence/sqlite/database.js";
import { newId, type RunId } from "../../shared/ids.js";
import { invariant } from "../../shared/errors.js";
import type { EventPayloads, EventType, RuntimeEvent } from "../../shared/events.js";

type EventRow = Omit<RuntimeEvent, "payload"> & { payloadJson: string };
export class EventStore {
  constructor(private readonly db: SqliteDatabase) {}
  append<K extends EventType>(runId: RunId, type: K, payload: EventPayloads[K]): RuntimeEvent<K> {
    const id = newId("event");
    const occurredAt = new Date().toISOString();
    const { lastInsertRowid: sequence } = this.db.execute(
      "INSERT INTO events(id, run_id, type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)",
      id, runId, type, JSON.stringify(payload), occurredAt,
    );
    return { id, sequence, runId, type, payload, occurredAt } as RuntimeEvent<K>;
  }
  list(runId: RunId, afterSequence = 0, limit = 1000): RuntimeEvent[] {
    invariant(Number.isSafeInteger(afterSequence) && afterSequence >= 0, "VALIDATION", "afterSequence must be a non-negative integer");
    invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 10000, "VALIDATION", "limit must be 1..10000");
    return this.db.all<EventRow>(
      `SELECT id, sequence, run_id AS runId, type, payload_json AS payloadJson, occurred_at AS occurredAt
       FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`, runId, afterSequence, limit,
    ).map(({ payloadJson, ...row }) => ({ ...row, payload: JSON.parse(payloadJson) }) as RuntimeEvent);
  }
}
