import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Fragment } from "effect/unstable/sql/Statement";

import type { Insertable, Selectable, Updateable } from "./column-type.ts";

type NullFilter = { isNull?: boolean };
type StringFilter = {
  equals?: string;
  not?: string;
  in?: string[];
  notIn?: string[];
  contains?: string;
  startsWith?: string;
  endsWith?: string;
} & NullFilter;
type NumberFilter = {
  equals?: number;
  not?: number;
  in?: number[];
  notIn?: number[];
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
} & NullFilter;
type BooleanFilter = { equals?: boolean; not?: boolean } & NullFilter;
type DateFilter = {
  equals?: Date;
  not?: Date;
  lt?: Date;
  lte?: Date;
  gt?: Date;
  gte?: Date;
} & NullFilter;
type FieldFilter<T> =
  NonNullable<T> extends string
    ? StringFilter
    : NonNullable<T> extends number
      ? NumberFilter
      : NonNullable<T> extends boolean
        ? BooleanFilter
        : NonNullable<T> extends Date
          ? DateFilter
          : { equals?: T; not?: T } & NullFilter;

export type WhereClause<T> = { [K in keyof T]?: T[K] | FieldFilter<T[K]> } & {
  AND?: WhereClause<T>[];
  OR?: WhereClause<T>[];
  NOT?: WhereClause<T>;
};
export type OrderByClause<T> = { [K in keyof T]?: "asc" | "desc" };
export type SelectClause<T> = { [K in keyof T]?: boolean };

export type FindArgs<T> = {
  where?: WhereClause<T>;
  select?: SelectClause<T>;
  orderBy?: OrderByClause<T>[];
  take?: number;
  skip?: number;
};
type SelectedKeys<T, S extends SelectClause<T>> = {
  [K in keyof T]: K extends keyof S ? (S[K] extends true ? K : never) : never;
}[keyof T];
export type SelectedResult<T, Args> = Args extends {
  select: infer S extends SelectClause<T>;
}
  ? Pick<T, SelectedKeys<T, S>>
  : T;
export type PaginateArgs<T> = Omit<FindArgs<T>, "take" | "skip"> & {
  orderBy: OrderByClause<T>[];
  take: number;
  skip?: number;
  after?: string;
  before?: string;
};
export interface PaginationMeta {
  count: number;
  hasNext: boolean;
  hasPrevious: boolean;
  startCursor: string | null;
  endCursor: string | null;
}
export interface PaginationResult<T> {
  data: T[];
  pagination: PaginationMeta;
}

export class ParanOrmError extends Error {
  readonly _tag = "ParanOrmError";
  constructor(
    readonly code: "BAD_REQUEST" | "NOT_FOUND",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ParanOrmError";
  }
}

type UniqueWhere<T> = { [K in keyof T]?: T[K] };
type OrmEffect<A> = Effect.Effect<A, ParanOrmError | SqlError, SqlClient>;

export interface ParanOrmModel<Table> {
  findMany<const Args extends FindArgs<Selectable<Table>> | undefined = undefined>(
    args?: Args,
  ): OrmEffect<SelectedResult<Selectable<Table>, Args>[]>;
  findFirst<const Args extends FindArgs<Selectable<Table>> | undefined = undefined>(
    args?: Args,
  ): OrmEffect<SelectedResult<Selectable<Table>, Args> | null>;
  findUnique(args: { where: UniqueWhere<Selectable<Table>> }): OrmEffect<Selectable<Table>>;
  create(args: { data: Insertable<Table> }): OrmEffect<Selectable<Table>>;
  createMany(args: { data: readonly Insertable<Table>[] }): OrmEffect<Selectable<Table>[]>;
  update(args: {
    where: UniqueWhere<Selectable<Table>>;
    data: Updateable<Table>;
  }): OrmEffect<Selectable<Table>>;
  updateMany(args: {
    where?: WhereClause<Selectable<Table>>;
    data: Updateable<Table>;
  }): OrmEffect<number>;
  delete(args: { where: UniqueWhere<Selectable<Table>> }): OrmEffect<Selectable<Table>>;
  deleteMany(args?: { where?: WhereClause<Selectable<Table>> }): OrmEffect<number>;
  upsert(args: {
    where: UniqueWhere<Selectable<Table>>;
    create: Insertable<Table>;
    update: Updateable<Table>;
  }): OrmEffect<Selectable<Table>>;
  count(args?: { where?: WhereClause<Selectable<Table>> }): OrmEffect<number>;
  exists(args?: { where?: WhereClause<Selectable<Table>> }): OrmEffect<boolean>;
  paginate<const Args extends PaginateArgs<Selectable<Table>>>(
    args: Args,
  ): OrmEffect<PaginationResult<SelectedResult<Selectable<Table>, Args>>>;
}
export type ParanOrm<TDB> = { [K in keyof TDB]: ParanOrmModel<TDB[K]> };

function escapeLike(value: unknown): string {
  return String(value).replace(/[\\%_]/g, (character) => `\\${character}`);
}

function fieldFragment(sql: SqlClient, field: string, filter: unknown): Fragment[] {
  if (filter === undefined) return [];
  if (
    filter === null ||
    typeof filter !== "object" ||
    filter instanceof Date ||
    Array.isArray(filter)
  )
    return [sql`${sql(field)} = ${filter}`];

  const fragments: Fragment[] = [];
  for (const [operation, value] of Object.entries(filter as Record<string, unknown>)) {
    switch (operation) {
      case "equals":
        fragments.push(sql`${sql(field)} = ${value}`);
        break;
      case "not":
        fragments.push(sql`${sql(field)} != ${value}`);
        break;
      case "in":
        fragments.push(sql`${sql.in(field, value as readonly unknown[])}`);
        break;
      case "notIn":
        fragments.push(sql`NOT ${sql.in(field, value as readonly unknown[])}`);
        break;
      case "lt":
        fragments.push(sql`${sql(field)} < ${value}`);
        break;
      case "lte":
        fragments.push(sql`${sql(field)} <= ${value}`);
        break;
      case "gt":
        fragments.push(sql`${sql(field)} > ${value}`);
        break;
      case "gte":
        fragments.push(sql`${sql(field)} >= ${value}`);
        break;
      case "contains":
        fragments.push(sql`${sql(field)} LIKE ${`%${escapeLike(value)}%`} ESCAPE '\\'`);
        break;
      case "startsWith":
        fragments.push(sql`${sql(field)} LIKE ${`${escapeLike(value)}%`} ESCAPE '\\'`);
        break;
      case "endsWith":
        fragments.push(sql`${sql(field)} LIKE ${`%${escapeLike(value)}`} ESCAPE '\\'`);
        break;
      case "isNull":
        fragments.push(value ? sql`${sql(field)} IS NULL` : sql`${sql(field)} IS NOT NULL`);
        break;
      default:
        fragments.push(sql`${sql(field)} = ${value}`);
    }
  }
  return fragments;
}

function clauseFragments(sql: SqlClient, clause: Record<string, unknown>): Fragment[] {
  const fragments: Fragment[] = [];
  for (const [field, filter] of Object.entries(clause)) {
    if (filter === undefined) continue;
    if (field === "AND" && Array.isArray(filter)) {
      const nested = filter.flatMap((item) =>
        clauseFragments(sql, item as Record<string, unknown>),
      );
      fragments.push(sql.and(nested));
    } else if (field === "OR" && Array.isArray(filter)) {
      fragments.push(
        sql.or(
          filter.map((item) => {
            const nested = clauseFragments(sql, item as Record<string, unknown>);
            return sql.and(nested);
          }),
        ),
      );
    } else if (field === "NOT") {
      const nested = clauseFragments(sql, filter as Record<string, unknown>);
      fragments.push(sql`NOT (${sql.and(nested)})`);
    } else fragments.push(...fieldFragment(sql, field, filter));
  }
  return fragments;
}

function whereFragment(sql: SqlClient, where?: Record<string, unknown>): Fragment | undefined {
  if (!where) return undefined;
  const fragments = clauseFragments(sql, where);
  return fragments.length ? sql.and(fragments) : undefined;
}

function orderFragments(sql: SqlClient, orderBy?: OrderByClause<any>[]): Fragment[] {
  if (!orderBy?.length) return [];
  const parts: Fragment[] = [];
  for (const order of orderBy)
    for (const [column, direction] of Object.entries(order))
      if (direction)
        parts.push(direction === "desc" ? sql`${sql(column)} DESC` : sql`${sql(column)} ASC`);
  return parts;
}

function encodeCursor(row: any, orderBy: OrderByClause<any>[]): string {
  const position: Record<string, any> = {};
  for (const order of orderBy)
    for (const column of Object.keys(order)) position[column] = row[column];
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeCursor(cursor: string): Record<string, any> {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new ParanOrmError("BAD_REQUEST", "Invalid pagination cursor", { cause });
  }
}
function cursorFragment(
  sql: SqlClient,
  cursor: Record<string, any>,
  orderBy: OrderByClause<any>[],
  direction: "after" | "before",
): Fragment | undefined {
  const entries = orderBy.flatMap((order) => Object.entries(order)) as [string, "asc" | "desc"][];
  if (!entries.length) return undefined;
  return sql.or(
    entries.map(([column, order], index) => {
      const parts = entries
        .slice(0, index)
        .map(([previous]) => sql`${sql(previous)} = ${cursor[previous]}`);
      const forward = direction === "after" ? order === "asc" : order === "desc";
      parts.push(
        forward ? sql`${sql(column)} > ${cursor[column]}` : sql`${sql(column)} < ${cursor[column]}`,
      );
      return sql.and(parts);
    }),
  );
}

function createModel<Table>(tableName: string): ParanOrmModel<Table> {
  type Row = Selectable<Table>;

  function selectedColumns(select?: SelectClause<Row>): string[] {
    return select
      ? Object.entries(select)
          .filter(([, enabled]) => enabled)
          .map(([column]) => column)
      : [];
  }

  const selectRows = (args?: FindArgs<Row>, limitOverride?: number): OrmEffect<any[]> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const where = whereFragment(sql, args?.where as Record<string, unknown> | undefined);
      const order = orderFragments(sql, args?.orderBy);
      const columns = selectedColumns(args?.select);
      const limit = limitOverride ?? args?.take;
      let query = columns.length
        ? sql`SELECT ${sql.csv(columns)} FROM ${sql(tableName)}`
        : sql`SELECT * FROM ${sql(tableName)}`;
      if (where) query = sql`${query} WHERE ${where}`;
      if (order.length) query = sql`${query} ORDER BY ${sql.csv(order)}`;
      if (limit !== undefined) query = sql`${query} LIMIT ${limit}`;
      if (args?.skip !== undefined) query = sql`${query} OFFSET ${args.skip}`;
      return [...(yield* query)];
    });

  const countRows = (where?: WhereClause<Row>): OrmEffect<number> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const filter = whereFragment(sql, where as Record<string, unknown> | undefined);
      let query = sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(tableName)}`;
      if (filter) query = sql`${query} WHERE ${filter}`;
      const [row] = yield* query;
      return Number(row?.n ?? 0);
    });

  const one = (rows: readonly Row[]): Effect.Effect<Row, ParanOrmError> =>
    rows[0] != null
      ? Effect.succeed(rows[0])
      : Effect.fail(new ParanOrmError("NOT_FOUND", `${tableName}: record not found`));

  const changes = (): OrmEffect<number> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const [row] = yield* sql<{ n: number }>`SELECT changes() AS n`;
      return Number(row?.n ?? 0);
    });

  const model: ParanOrmModel<Table> = {
    findMany: (args) => selectRows(args),
    findFirst: (args) => selectRows(args, 1).pipe(Effect.map((rows) => (rows[0] as any) ?? null)),
    findUnique: ({ where }) =>
      selectRows({ where: where as WhereClause<Row> }, 1).pipe(
        Effect.flatMap((rows) => one(rows as Row[])),
      ),
    create: ({ data }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows =
          yield* sql<Row>`INSERT INTO ${sql(tableName)} ${sql.insert(data as any).returning("*")}`;
        return yield* one(rows);
      }),
    createMany: ({ data }) =>
      Effect.gen(function* () {
        if (!data.length) return [];
        const sql = yield* SqlClient;
        return [
          ...(yield* sql<Row>`INSERT INTO ${sql(tableName)} ${sql.insert(data as any).returning("*")}`),
        ];
      }),
    update: ({ where, data }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const filter = whereFragment(sql, where as Record<string, unknown>);
        let query = sql<Row>`UPDATE ${sql(tableName)} SET ${sql.update(data as any)}`;
        if (filter) query = sql`${query} WHERE ${filter}`;
        query = sql`${query} RETURNING *`;
        return yield* one(yield* query);
      }),
    updateMany: ({ where, data }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const filter = whereFragment(sql, where as Record<string, unknown> | undefined);
        let query = sql`UPDATE ${sql(tableName)} SET ${sql.update(data as any)}`;
        if (filter) query = sql`${query} WHERE ${filter}`;
        yield* query;
        return yield* changes();
      }),
    delete: ({ where }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const filter = whereFragment(sql, where as Record<string, unknown>);
        let query = sql<Row>`DELETE FROM ${sql(tableName)}`;
        if (filter) query = sql`${query} WHERE ${filter}`;
        query = sql`${query} RETURNING *`;
        return yield* one(yield* query);
      }),
    deleteMany: (args) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const filter = whereFragment(sql, args?.where as Record<string, unknown> | undefined);
        let query = sql`DELETE FROM ${sql(tableName)}`;
        if (filter) query = sql`${query} WHERE ${filter}`;
        yield* query;
        return yield* changes();
      }),
    upsert: ({ where, create, update }) =>
      Effect.gen(function* () {
        const columns = Object.keys(where);
        if (!columns.length)
          return yield* Effect.fail(
            new ParanOrmError("BAD_REQUEST", `${tableName}.upsert requires a conflict key`),
          );
        const sql = yield* SqlClient;
        const rows = yield* sql<Row>`
          INSERT INTO ${sql(tableName)} ${sql.insert(create as any)}
          ON CONFLICT (${sql.csv(columns)}) DO UPDATE SET ${sql.update(update as any)}
          RETURNING *
        `;
        return yield* one(rows);
      }),
    count: (args) => countRows(args?.where),
    exists: (args) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const filter = whereFragment(sql, args?.where as Record<string, unknown> | undefined);
        let query = sql`SELECT 1 AS x FROM ${sql(tableName)}`;
        if (filter) query = sql`${query} WHERE ${filter}`;
        query = sql`${query} LIMIT 1`;
        return (yield* query).length > 0;
      }),
    paginate: (args) =>
      Effect.gen(function* () {
        const { take, skip, after, before, orderBy, where, ...rest } = args;
        const count = yield* countRows(where);
        if (skip !== undefined) {
          const data = yield* selectRows({
            ...(rest as FindArgs<Row>),
            ...(where !== undefined ? { where } : {}),
            orderBy,
            take,
            skip,
          } as FindArgs<Row>);
          return {
            data,
            pagination: {
              count,
              hasNext: skip + data.length < count,
              hasPrevious: skip > 0,
              startCursor: null,
              endCursor: null,
            },
          };
        }

        const sql = yield* SqlClient;
        const direction = before !== undefined ? "before" : "after";
        const filter = whereFragment(sql, where as Record<string, unknown> | undefined);
        let cursorFilter: Fragment | undefined;
        try {
          if (after) cursorFilter = cursorFragment(sql, decodeCursor(after), orderBy, "after");
          else if (before)
            cursorFilter = cursorFragment(sql, decodeCursor(before), orderBy, "before");
        } catch (error) {
          return yield* Effect.fail(error as ParanOrmError);
        }

        const effective: OrderByClause<Row>[] =
          direction === "before"
            ? orderBy.map(
                (order) =>
                  Object.fromEntries(
                    Object.entries(order).map(([column, value]) => [
                      column,
                      value === "asc" ? "desc" : "asc",
                    ]),
                  ) as OrderByClause<Row>,
              )
            : orderBy;
        const order = orderFragments(sql, effective);
        const columns = selectedColumns(rest.select);

        let query = columns.length
          ? sql`SELECT ${sql.csv(columns)} FROM ${sql(tableName)}`
          : sql`SELECT * FROM ${sql(tableName)}`;
        const filters = [filter, cursorFilter].filter(Boolean) as Fragment[];
        if (filters.length) query = sql`${query} WHERE ${sql.and(filters)}`;
        if (order.length) query = sql`${query} ORDER BY ${sql.csv(order)}`;
        query = sql`${query} LIMIT ${take + 1}`;

        let rows: any[] = [...(yield* query)];
        const hasMore = rows.length > take;
        if (hasMore) rows = rows.slice(0, take);
        if (direction === "before") rows.reverse();

        return {
          data: rows,
          pagination: {
            count,
            hasNext: direction === "after" ? hasMore : after !== undefined,
            hasPrevious: direction === "before" ? hasMore : before !== undefined,
            startCursor: rows.length ? encodeCursor(rows[0], orderBy) : null,
            endCursor: rows.length ? encodeCursor(rows.at(-1), orderBy) : null,
          },
        };
      }),
  };

  return model;
}

/**
 * Creates typed models from a database interface. Each method returns an Effect
 * that requires `SqlClient` — provide either `@effect/sql-d1` or
 * `@effect/sql-sqlite-node` at the edges.
 */
export function paranorm<TDB>(): ParanOrm<TDB> {
  const models: Record<string, unknown> = {};
  const model = (tableName: string) => {
    models[tableName] ??= createModel(tableName);
    return models[tableName];
  };

  return new Proxy(models, {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      if (property === "then" && !(property in target)) return undefined;
      return model(property);
    },
  }) as ParanOrm<TDB>;
}
