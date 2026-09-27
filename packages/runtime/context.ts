import type { SqliteDatabase } from "../persistence/sqlite/database.js";
import type { EventPayloads, EventType, RuntimeEvent } from "../shared/events.js";
import type { RunId } from "../shared/ids.js";
import type { EventBus } from "./events/bus.js";
import type { EventStore } from "./events/store.js";
import { Queries } from "./queries.js";

export type Emit = <K extends EventType>(runId: RunId, type: K, payload: EventPayloads[K]) => void;

export class RuntimeContext {
  readonly read: Queries;
  constructor(readonly db: SqliteDatabase, private readonly eventStore: EventStore, private readonly bus: EventBus) {
    this.read = new Queries(db);
  }
  command<T>(operation: (emit: Emit) => T): T {
    const events: RuntimeEvent[] = [];
    const result = this.db.transaction(() => operation((runId, type, payload) => {
      events.push(this.eventStore.append(runId, type, payload) as RuntimeEvent);
    }));
    // No callback can observe an uncommitted mutation. Reentrant commands queue their events.
    this.bus.publish(events);
    return result;
  }
}
