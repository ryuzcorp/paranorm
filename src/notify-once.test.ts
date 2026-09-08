import { describe, expect, test } from "bun:test";

import { SqliteClient } from "@effect/sql-sqlite-node";
import type { Layer } from "effect";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

import { afterWrite } from "./notify.ts";
import { IdempotencyConflictError, once } from "./once.ts";

const sqliteLayer = (filename = ":memory:") =>
  // SAFETY: SqliteClient.layer provides SqlClient when scoped via Effect.scoped.
  SqliteClient.layer({ disableWAL: true, filename }) as Layer.Layer<
    SqlClient | SqliteClient.SqliteClient
  >;

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(sqliteLayer()), Effect.scoped));

describe("afterWrite", () => {
  test("taps successful values", async () => {
    const seen: number[] = [];
    const value = await Effect.runPromise(
      Effect.succeed(7).pipe(afterWrite((n) => seen.push(n)))
    );
    expect(value).toBe(7);
    expect(seen).toEqual([7]);
  });

  test("skips tap on failure", async () => {
    const seen: number[] = [];
    await expect(
      Effect.runPromise(
        Effect.fail(new Error("boom")).pipe(afterWrite(() => seen.push(1)))
      )
    ).rejects.toThrow("boom");
    expect(seen).toEqual([]);
  });
});

describe("once", () => {
  test("runs fn once per key", async () => {
    const calls: string[] = [];
    const setup = Effect.gen(function* setupIdempotency() {
      const sql = yield* SqliteClient.SqliteClient;
      yield* sql`
        CREATE TABLE paranorm_idempotency (
          key TEXT PRIMARY KEY NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `;
    });

    await run(
      setup.pipe(
        Effect.andThen(
          once("k1", () =>
            Effect.sync(() => {
              calls.push("a");
              return "ok";
            })
          )
        ),
        Effect.andThen(
          once("k1", () =>
            Effect.sync(() => {
              calls.push("b");
              return "again";
            })
          )
        ),
        Effect.andThen((second) =>
          Effect.sync(() => {
            expect(second).toBeNull();
            expect(calls).toEqual(["a"]);
          })
        )
      )
    );
  });

  test("throws when ignoreDuplicate is false", async () => {
    await expect(
      run(
        Effect.gen(function* onceConflict() {
          const sql = yield* SqliteClient.SqliteClient;
          yield* sql`
            CREATE TABLE paranorm_idempotency (
              key TEXT PRIMARY KEY NOT NULL,
              created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
          `;
          yield* once("dup", () => Effect.succeed(1), {
            ignoreDuplicate: false,
          });
          yield* once("dup", () => Effect.succeed(2), {
            ignoreDuplicate: false,
          });
        })
      )
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test("supports a custom idempotency table", async () => {
    const calls: string[] = [];
    await run(
      Effect.gen(function* customTable() {
        const sql = yield* SqliteClient.SqliteClient;
        yield* sql`
          CREATE TABLE custom_once (
            key TEXT PRIMARY KEY NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `;
        const first = yield* once(
          "k",
          () =>
            Effect.sync(() => {
              calls.push("a");
              return 1;
            }),
          { table: "custom_once" }
        );
        const second = yield* once(
          "k",
          () =>
            Effect.sync(() => {
              calls.push("b");
              return 2;
            }),
          { table: "custom_once" }
        );
        expect(first).toBe(1);
        expect(second).toBeNull();
        expect(calls).toEqual(["a"]);
      })
    );
  });
});
