/**
 * Node SQLite dialect for ParanORM (`node:sqlite`, Node 22.16+).
 *
 * Use this entry from standard Fetch / Node runtimes:
 *
 * ```ts
 * import { SqliteClient } from "paranorm/sqlite-node"
 * import { paranorm } from "paranorm"
 *
 * const program = Effect.gen(function* () {
 *   const orm = paranorm<DB>()
 *   return yield* orm.users.findMany()
 * }).pipe(Effect.provide(SqliteClient.layer({ filename: "app.db" })))
 * ```
 */
export * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
export * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
