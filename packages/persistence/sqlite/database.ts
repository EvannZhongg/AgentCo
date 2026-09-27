import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { RuntimeError, invariant } from "../../shared/errors.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

// Internal persistence primitive; never exposed by the runtime package entry point.
export class SqliteDatabase {
  readonly #connection: DatabaseSync;
  #closed = false;
  constructor(filename: string) {
    this.#connection = new DatabaseSync(filename);
    try {
      this.#connection.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.transaction(() => {
        const version = this.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
        if (version === 0) {
          this.#connection.exec(SCHEMA_SQL);
          this.#connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version !== SCHEMA_VERSION) {
          throw new RuntimeError("SCHEMA_VERSION", `Expected schema ${SCHEMA_VERSION}, found ${version}`);
        }
      });
    } catch (error) {
      this.#connection.close();
      throw error;
    }
  }
  #assertOpen(): void { invariant(!this.#closed, "CLOSED", "Runtime is closed"); }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    this.#assertOpen();
    return this.#connection.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    this.#assertOpen();
    return this.#connection.prepare(sql).all(...params) as T[];
  }
  execute(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    this.#assertOpen();
    const result = this.#connection.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }
  transaction<T>(operation: () => T): T {
    this.#assertOpen();
    this.#connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.#connection.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#connection.close();
    this.#closed = true;
  }
}
