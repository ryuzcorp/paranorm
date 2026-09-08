import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export class IdempotencyConflictError extends Error {
  override name = "IdempotencyConflictError";
  readonly key: string;

  constructor(key: string) {
    super(`Idempotency key already used: ${key}`);
    this.key = key;
  }
}

export interface OnceOptions {
  /**
   * When true (default), a duplicate key returns `null` without running `fn`.
   * When false, throws `IdempotencyConflictError`.
   */
  ignoreDuplicate?: boolean;
  /** SQL table name. Default `paranorm_idempotency`. */
  table?: string;
}

/**
 * Run `fn` at most once per key (insert-or-ignore claim).
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS paranorm_idempotency (
 *   key TEXT PRIMARY KEY NOT NULL,
 *   created_at TEXT NOT NULL DEFAULT (datetime('now'))
 * );
 * ```
 */
export const once = function once<A, E, R>(
  key: string,
  fn: () => Effect.Effect<A, E, R>,
  options?: OnceOptions
): Effect.Effect<
  A | null,
  E | SqlError | IdempotencyConflictError,
  R | SqlClient
> {
  const table = options?.table ?? "paranorm_idempotency";
  const ignoreDuplicate = options?.ignoreDuplicate ?? true;

  return Effect.gen(function* onceGen() {
    const sql = yield* SqlClient;
    yield* sql`INSERT OR IGNORE INTO ${sql(table)} (key) VALUES (${key})`;
    const changes = yield* sql<{ c: number }>`SELECT changes() AS c`;
    const claimed = (changes[0]?.c ?? 0) > 0;
    if (!claimed) {
      if (!ignoreDuplicate) {
        return yield* Effect.fail(new IdempotencyConflictError(key));
      }
      return null;
    }
    return yield* fn();
  });
};
