import type { EventListener, EventType, RuntimeEvent } from "../../shared/events.js";
import { invariant } from "../../shared/errors.js";

export type ListenerErrorHandler = (error: unknown, event: RuntimeEvent) => void;

export class EventBus {
  readonly #listeners = new Set<{ type: EventType | "*"; listener: EventListener }>();
  readonly #queue: RuntimeEvent[] = [];
  #dispatching = false;
  #closed = false;
  constructor(private readonly onError: ListenerErrorHandler) {}
  subscribe<K extends EventType>(type: K, listener: EventListener<K>): () => void;
  subscribe(type: "*", listener: EventListener): () => void;
  subscribe(type: EventType | "*", listener: EventListener<never>): () => void {
    invariant(!this.#closed, "CLOSED", "Runtime is closed");
    const entry = { type, listener: listener as EventListener };
    this.#listeners.add(entry);
    return () => { this.#listeners.delete(entry); };
  }
  #report(error: unknown, event: RuntimeEvent): void {
    try { this.onError(error, structuredClone(event)); } catch (handlerError) {
      process.emitWarning(`Runtime event error handler failed: ${String(handlerError)}`);
    }
  }
  publish(events: readonly RuntimeEvent[]): void {
    this.#queue.push(...events);
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      while (this.#queue.length > 0) {
        const event = this.#queue.shift()!;
        for (const entry of [...this.#listeners]) {
          if (entry.type !== "*" && entry.type !== event.type) continue;
          try {
            const result = entry.listener(structuredClone(event));
            if (result) void Promise.resolve(result).catch(error => this.#report(error, event));
          } catch (error) { this.#report(error, event); }
        }
      }
    } finally { this.#dispatching = false; }
  }
  close(): void { this.#listeners.clear(); this.#closed = true; }
}
