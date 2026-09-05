/**
 * Cloudflare D1 dialect for ParanORM.
 *
 * Use this entry from Workers / celld environments:
 *
 * ```ts
 * import { D1Client } from "paranorm/d1"
 * import { paranorm } from "paranorm"
 *
 * const program = Effect.gen(function* () {
 *   const orm = paranorm<DB>()
 *   return yield* orm.users.findMany()
 * }).pipe(Effect.provide(D1Client.layer({ db: env.DB })))
 * ```
 */
export * as D1Client from "@effect/sql-d1/D1Client";
