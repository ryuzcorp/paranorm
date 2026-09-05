import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Fragment, Statement } from "effect/unstable/sql/Statement";

import type { Insertable, Selectable, Updateable } from "./column-type.ts";

interface NullFilter {
  isNull?: boolean;
}

interface StringFilter extends NullFilter {
  contains?: string;
  endsWith?: string;
  equals?: string;
  in?: string[];
  not?: string;
  notIn?: string[];
  startsWith?: string;
}

interface NumberFilter extends NullFilter {
  equals?: number;
  gt?: number;
  gte?: number;
  in?: number[];
  lt?: number;
  lte?: number;
  not?: number;
  notIn?: number[];
}

interface BooleanFilter extends NullFilter {
  equals?: boolean;
  not?: boolean;
}

interface DateFilter extends NullFilter {
  equals?: Date;
  gt?: Date;
  gte?: Date;
  lt?: Date;
  lte?: Date;
  not?: Date;
}

type FieldFilter<T> =
  NonNullable<T> extends string
    ? StringFilter
    : NonNullable<T> extends number
      ? NumberFilter
      : NonNullable<T> extends boolean
        ? BooleanFilter
        : NonNullable<T> extends Date
          ? DateFilter
          : { equals?: T; isNull?: boolean; not?: T };

export type WhereClause<T> = {
  [K in keyof T]?: FieldFilter<T[K]> | T[K];
} & {
  AND?: WhereClause<T>[];
  NOT?: WhereClause<T>;
  OR?: WhereClause<T>[];
};

export type OrderByClause<T> = { [K in keyof T]?: "asc" | "desc" };

export type SelectClause<T> = { [K in keyof T]?: boolean };

export interface FindArgs<T> {
  orderBy?: OrderByClause<T>[];
  select?: SelectClause<T>;
  skip?: number;
  take?: number;
  where?: WhereClause<T>;
}

type SelectedKeys<T, S extends SelectClause<T>> = {
  [K in keyof T]: K extends keyof S ? (S[K] extends true ? K : never) : never;
}[keyof T];

export type SelectedResult<T, Args> = Args extends {
  select: infer S extends SelectClause<T>;
}
  ? Pick<T, SelectedKeys<T, S>>
  : T;

export type PaginateArgs<T> = Omit<FindArgs<T>, "skip" | "take"> & {
  after?: string;
  before?: string;
  orderBy: OrderByClause<T>[];
  skip?: number;
  take: number;
};

export interface PaginationMeta {
  count: number;
  endCursor: string | null;
  hasNext: boolean;
  hasPrevious: boolean;
  startCursor: string | null;
}

export interface PaginationResult<T> {
  data: T[];
  pagination: PaginationMeta;
}

export class ParanOrmError extends Error {
  readonly _tag = "ParanOrmError";
  readonly code: "BAD_REQUEST" | "NOT_FOUND";

  constructor(
    code: "BAD_REQUEST" | "NOT_FOUND",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ParanOrmError";
    this.code = code;
  }
}

type SqlPrimitive = boolean | Date | null | number | string;
type SqlRowPayload = Record<string, SqlPrimitive | undefined>;
type CursorPosition = Record<string, SqlPrimitive>;
type OrderEntry = [string, "asc" | "desc"];
type UniqueWhere<T> = { [K in keyof T]?: T[K] };
type OrmEffect<A> = Effect.Effect<A, ParanOrmError | SqlError, SqlClient>;
type FilterOperations = StringFilter &
  NumberFilter &
  BooleanFilter &
  DateFilter;
type WhereFieldValue =
  | FilterOperations
  | readonly SqlPrimitive[]
  | SqlPrimitive;

export interface ParanOrmModel<Table> {
  count: (args?: {
    where?: WhereClause<Selectable<Table>>;
  }) => OrmEffect<number>;
  create: (args: { data: Insertable<Table> }) => OrmEffect<Selectable<Table>>;
  createMany: (args: {
    data: readonly Insertable<Table>[];
  }) => OrmEffect<Selectable<Table>[]>;
  delete: (args: {
    where: UniqueWhere<Selectable<Table>>;
  }) => OrmEffect<Selectable<Table>>;
  deleteMany: (args?: {
    where?: WhereClause<Selectable<Table>>;
  }) => OrmEffect<number>;
  exists: (args?: {
    where?: WhereClause<Selectable<Table>>;
  }) => OrmEffect<boolean>;
  findFirst: <
    const Args extends FindArgs<Selectable<Table>> | undefined = undefined,
  >(
    args?: Args
  ) => OrmEffect<SelectedResult<Selectable<Table>, Args> | null>;
  findMany: <
    const Args extends FindArgs<Selectable<Table>> | undefined = undefined,
  >(
    args?: Args
  ) => OrmEffect<SelectedResult<Selectable<Table>, Args>[]>;
  findUnique: (args: {
    where: UniqueWhere<Selectable<Table>>;
  }) => OrmEffect<Selectable<Table>>;
  paginate: <const Args extends PaginateArgs<Selectable<Table>>>(
    args: Args
  ) => OrmEffect<PaginationResult<SelectedResult<Selectable<Table>, Args>>>;
  update: (args: {
    data: Updateable<Table>;
    where: UniqueWhere<Selectable<Table>>;
  }) => OrmEffect<Selectable<Table>>;
  updateMany: (args: {
    data: Updateable<Table>;
    where?: WhereClause<Selectable<Table>>;
  }) => OrmEffect<number>;
  upsert: (args: {
    create: Insertable<Table>;
    update: Updateable<Table>;
    where: UniqueWhere<Selectable<Table>>;
  }) => OrmEffect<Selectable<Table>>;
}

export type ParanOrm<TDB> = { [K in keyof TDB]: ParanOrmModel<TDB[K]> };

const escapeLike = (value: SqlPrimitive): string =>
  String(value).replaceAll(/[\\%_]/gu, (character) => `\\${character}`);

const isFilterOperations = (
  filter: WhereFieldValue
): filter is FilterOperations => {
  if (filter === null || filter instanceof Date || Array.isArray(filter)) {
    return false;
  }
  return Object(filter) === filter;
};

interface JsonCursorObject {
  [key: string]: JsonCursorValue;
}
type JsonCursorValue =
  | boolean
  | JsonCursorObject
  | JsonCursorValue[]
  | null
  | number
  | string;

const isJsonCursorObject = (
  value: JsonCursorValue
): value is JsonCursorObject =>
  value !== null && Object(value) === value && !Array.isArray(value);

const isLogicalField = (field: string): field is "AND" | "NOT" | "OR" =>
  field === "AND" || field === "NOT" || field === "OR";

const appendFilterFragments = (
  sql: SqlClient,
  field: string,
  operations: FilterOperations
): Fragment[] => {
  const fragments: Fragment[] = [];
  if (operations.contains !== undefined) {
    fragments.push(
      sql`${sql(field)} LIKE ${`%${escapeLike(operations.contains)}%`} ESCAPE '\\'`
    );
  }
  if (operations.endsWith !== undefined) {
    fragments.push(
      sql`${sql(field)} LIKE ${`%${escapeLike(operations.endsWith)}`} ESCAPE '\\'`
    );
  }
  if (operations.equals !== undefined) {
    fragments.push(sql`${sql(field)} = ${operations.equals}`);
  }
  if (operations.gt !== undefined) {
    fragments.push(sql`${sql(field)} > ${operations.gt}`);
  }
  if (operations.gte !== undefined) {
    fragments.push(sql`${sql(field)} >= ${operations.gte}`);
  }
  if (operations.in !== undefined) {
    fragments.push(sql`${sql.in(field, operations.in)}`);
  }
  if (operations.isNull !== undefined) {
    fragments.push(
      operations.isNull
        ? sql`${sql(field)} IS NULL`
        : sql`${sql(field)} IS NOT NULL`
    );
  }
  if (operations.lt !== undefined) {
    fragments.push(sql`${sql(field)} < ${operations.lt}`);
  }
  if (operations.lte !== undefined) {
    fragments.push(sql`${sql(field)} <= ${operations.lte}`);
  }
  if (operations.not !== undefined) {
    fragments.push(sql`${sql(field)} != ${operations.not}`);
  }
  if (operations.notIn !== undefined) {
    fragments.push(sql`NOT ${sql.in(field, operations.notIn)}`);
  }
  if (operations.startsWith !== undefined) {
    fragments.push(
      sql`${sql(field)} LIKE ${`${escapeLike(operations.startsWith)}%`} ESCAPE '\\'`
    );
  }
  return fragments;
};

const fieldFragment = (
  sql: SqlClient,
  field: string,
  filter: WhereFieldValue
): Fragment[] => {
  if (!isFilterOperations(filter)) {
    return [sql`${sql(field)} = ${filter}`];
  }
  return appendFilterFragments(sql, field, filter);
};

const clauseFragments = <T>(
  sql: SqlClient,
  clause: WhereClause<T>
): Fragment[] => {
  const fragments: Fragment[] = [];
  if (clause.AND !== undefined) {
    const nested = clause.AND.flatMap((item) => clauseFragments(sql, item));
    fragments.push(sql.and(nested));
  }
  if (clause.OR !== undefined) {
    fragments.push(
      sql.or(clause.OR.map((item) => sql.and(clauseFragments(sql, item))))
    );
  }
  if (clause.NOT !== undefined) {
    fragments.push(sql`NOT (${sql.and(clauseFragments(sql, clause.NOT))})`);
  }
  for (const [field, filter] of Object.entries(clause)) {
    if (filter === undefined || isLogicalField(field)) {
      continue;
    }
    // SAFETY: logical keys are skipped; remaining entries are field filters or primitives.
    fragments.push(...fieldFragment(sql, field, filter as WhereFieldValue));
  }
  return fragments;
};

const whereFragment = <T>(
  sql: SqlClient,
  where?: WhereClause<T>
): Fragment | undefined => {
  if (where === undefined) {
    return undefined;
  }
  const fragments = clauseFragments(sql, where);
  if (fragments.length === 0) {
    return undefined;
  }
  return sql.and(fragments);
};

const orderFragments = <T>(
  sql: SqlClient,
  orderBy?: OrderByClause<T>[],
  flipDirection = false
): Fragment[] => {
  if (orderBy === undefined || orderBy.length === 0) {
    return [];
  }
  const parts: Fragment[] = [];
  for (const order of orderBy) {
    for (const [column, direction] of Object.entries(order)) {
      if (direction === "asc" || direction === "desc") {
        let effective: "asc" | "desc" = direction;
        if (flipDirection) {
          effective = direction === "asc" ? "desc" : "asc";
        }
        parts.push(
          effective === "desc"
            ? sql`${sql(column)} DESC`
            : sql`${sql(column)} ASC`
        );
      }
    }
  }
  return parts;
};

const orderEntries = <T>(orderBy: OrderByClause<T>[]): OrderEntry[] => {
  const entries: OrderEntry[] = [];
  for (const order of orderBy) {
    for (const [column, direction] of Object.entries(order)) {
      if (direction === "asc" || direction === "desc") {
        entries.push([column, direction]);
      }
    }
  }
  return entries;
};

const encodeCursor = <T>(row: T, orderBy: OrderByClause<T>[]): string => {
  const position: CursorPosition = {};
  for (const order of orderBy) {
    for (const column of Object.keys(order)) {
      // SAFETY: order-by columns are SqlPrimitive fields selected for cursor encoding.
      position[column] = row[column as keyof T] as SqlPrimitive;
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const parseCursorPrimitive = (value: JsonCursorValue): SqlPrimitive | null => {
  if (value === null) {
    return null;
  }
  if (value === true || value === false) {
    return value;
  }
  if (Number.isFinite(value)) {
    // SAFETY: Number.isFinite excludes non-numeric cursor values.
    return value as number;
  }
  if (Object(value) !== value) {
    // SAFETY: non-object primitives here are cursor-encoded strings.
    return value as SqlPrimitive;
  }
  return null;
};

const parseCursorJson = (text: string): JsonCursorObject => {
  const parsed: JsonCursorValue = JSON.parse(text);
  if (!isJsonCursorObject(parsed)) {
    throw new Error("invalid cursor shape");
  }
  return parsed;
};

const decodeCursor = (cursor: string) => {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(
      binary,
      (character) => character.codePointAt(0) ?? 0
    );
    const parsed = parseCursorJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    const position: CursorPosition = {};
    for (const [key, value] of Object.entries(parsed)) {
      const primitive = parseCursorPrimitive(value);
      if (primitive === null && value !== null) {
        throw new Error("invalid cursor value");
      }
      position[key] = primitive;
    }
    return position;
  } catch (error) {
    throw new ParanOrmError("BAD_REQUEST", "Invalid pagination cursor", {
      cause: error,
    });
  }
};

const cursorFragment = <T>(
  sql: SqlClient,
  cursor: CursorPosition,
  orderBy: OrderByClause<T>[],
  direction: "after" | "before"
): Fragment | undefined => {
  const entries = orderEntries(orderBy);
  if (entries.length === 0) {
    return undefined;
  }
  return sql.or(
    entries.map(([column, order], index) => {
      const parts = entries
        .slice(0, index)
        .map(([previous]) => sql`${sql(previous)} = ${cursor[previous]}`);
      const forward =
        direction === "after" ? order === "asc" : order === "desc";
      parts.push(
        forward
          ? sql`${sql(column)} > ${cursor[column]}`
          : sql`${sql(column)} < ${cursor[column]}`
      );
      return sql.and(parts);
    })
  );
};

const selectedColumns = <T>(select?: SelectClause<T>): string[] =>
  select
    ? Object.entries(select)
        .filter(([, enabled]) => enabled)
        .map(([column]) => column)
    : [];

const sqliteChanges = (sql: SqlClient): OrmEffect<number> =>
  Effect.gen(function* sqliteChangesGen() {
    const [row] = yield* sql<{ n: number }>`SELECT changes() AS n`;
    return Number(row?.n ?? 0);
  });

const withReturning = <Row extends object>(
  sql: SqlClient,
  query: Statement<Row>
): Statement<Row> =>
  sql.onDialectOrElse({
    mssql: () => sql<Row>`${query} OUTPUT INSERTED.*`,
    orElse: () => sql<Row>`${query} RETURNING *`,
  });

const mutateManyCount = (
  sql: SqlClient,
  query: Statement<object>
): OrmEffect<number> =>
  sql.onDialectOrElse({
    orElse: () =>
      Effect.gen(function* returningCountGen() {
        return (yield* withReturning(sql, query)).length;
      }),
    sqlite: () =>
      Effect.gen(function* sqliteCountGen() {
        yield* query;
        return yield* sqliteChanges(sql);
      }),
  });

const oneRow = <Row>(
  tableName: string,
  rows: readonly Row[]
): Effect.Effect<Row, ParanOrmError> => {
  if (rows[0] === undefined) {
    return Effect.fail(
      new ParanOrmError("NOT_FOUND", `${tableName}: record not found`)
    );
  }
  return Effect.succeed(rows[0]);
};

const toSqlPayload = <T extends SqlRowPayload>(data: T): T => data;

const toUpdatePayload = <Table>(data: Updateable<Table>): SqlRowPayload =>
  // SAFETY: Updateable columns are SqlPrimitive values at runtime.
  data as SqlRowPayload;

const createModel = <Table>(tableName: string): ParanOrmModel<Table> => {
  type Row = Selectable<Table>;

  const selectRows = <const Args extends FindArgs<Row> | undefined = undefined>(
    args?: Args,
    limitOverride?: number
  ): OrmEffect<SelectedResult<Row, Args>[]> =>
    Effect.gen(function* selectRowsGen() {
      const sql = yield* SqlClient;
      const where = whereFragment<Row>(sql, args?.where);
      const order = orderFragments(sql, args?.orderBy);
      const columns = selectedColumns(args?.select);
      const limit = limitOverride ?? args?.take;
      let query = columns.length
        ? sql<Row>`SELECT ${sql.csv(columns)} FROM ${sql(tableName)}`
        : sql<Row>`SELECT * FROM ${sql(tableName)}`;
      if (where) {
        query = sql`${query} WHERE ${where}`;
      }
      if (order.length) {
        query = sql`${query} ORDER BY ${sql.csv(order)}`;
      }
      if (limit !== undefined) {
        query = sql`${query} LIMIT ${limit}`;
      }
      if (args?.skip !== undefined) {
        query = sql`${query} OFFSET ${args.skip}`;
      }
      // SAFETY: selected columns match SelectedResult for Args at the type level.
      return [...(yield* query)] as SelectedResult<Row, Args>[];
    });

  const countRows = (where?: WhereClause<Row>): OrmEffect<number> =>
    Effect.gen(function* countRowsGen() {
      const sql = yield* SqlClient;
      const filter = whereFragment<Row>(sql, where);
      let query = sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM ${sql(tableName)}`;
      if (filter) {
        query = sql`${query} WHERE ${filter}`;
      }
      const [row] = yield* query;
      return Number(row?.n ?? 0);
    });

  const paginateWithSkip = <const Args extends PaginateArgs<Row>>(
    args: Args & { skip: number },
    totalCount: number
  ): OrmEffect<PaginationResult<SelectedResult<Row, Args>>> =>
    Effect.gen(function* paginateWithSkipGen() {
      const { skip } = args;
      const data = yield* selectRows(args);
      return {
        data,
        pagination: {
          count: totalCount,
          endCursor: null,
          hasNext: skip + data.length < totalCount,
          hasPrevious: skip > 0,
          startCursor: null,
        },
      };
    });

  const paginateWithCursor = <const Args extends PaginateArgs<Row>>(
    args: Args,
    totalCount: number
  ): OrmEffect<PaginationResult<SelectedResult<Row, Args>>> =>
    Effect.gen(function* paginateWithCursorGen() {
      const { after, before, orderBy, take, where, ...rest } = args;
      const sql = yield* SqlClient;
      const direction = before === undefined ? "after" : "before";
      const filter = whereFragment<Row>(sql, where);
      let cursorFilter: Fragment | undefined;
      try {
        if (after !== undefined) {
          cursorFilter = cursorFragment(
            sql,
            decodeCursor(after),
            orderBy,
            "after"
          );
        } else if (before !== undefined) {
          cursorFilter = cursorFragment(
            sql,
            decodeCursor(before),
            orderBy,
            "before"
          );
        }
      } catch (error) {
        if (error instanceof ParanOrmError) {
          return yield* Effect.fail(error);
        }
        return yield* Effect.fail(
          new ParanOrmError("BAD_REQUEST", "Invalid pagination cursor", {
            cause: error,
          })
        );
      }

      const order = orderFragments(sql, orderBy, direction === "before");
      const columns = selectedColumns(rest.select);

      let query = columns.length
        ? sql`SELECT ${sql.csv(columns)} FROM ${sql(tableName)}`
        : sql`SELECT * FROM ${sql(tableName)}`;
      const filters: Fragment[] = [];
      if (filter !== undefined) {
        filters.push(filter);
      }
      if (cursorFilter !== undefined) {
        filters.push(cursorFilter);
      }
      if (filters.length) {
        query = sql`${query} WHERE ${sql.and(filters)}`;
      }
      if (order.length) {
        query = sql`${query} ORDER BY ${sql.csv(order)}`;
      }
      query = sql`${query} LIMIT ${take + 1}`;

      // SAFETY: selected columns match SelectedResult for Args at the type level.
      let rows = [...(yield* query)] as SelectedResult<Row, Args>[];
      const hasMore = rows.length > take;
      if (hasMore) {
        rows = rows.slice(0, take);
      }
      if (direction === "before") {
        rows.reverse();
      }

      const [firstRow] = rows;
      const lastRow = rows.at(-1);

      return {
        data: rows,
        pagination: {
          count: totalCount,
          endCursor:
            lastRow === undefined ? null : encodeCursor(lastRow, orderBy),
          hasNext: direction === "after" ? hasMore : after !== undefined,
          hasPrevious: direction === "before" ? hasMore : before !== undefined,
          startCursor:
            firstRow === undefined ? null : encodeCursor(firstRow, orderBy),
        },
      };
    });

  const model: ParanOrmModel<Table> = {
    count: (args) => countRows(args?.where),
    create: ({ data }) =>
      Effect.gen(function* createGen() {
        const sql = yield* SqlClient;
        const rows =
          yield* sql<Row>`INSERT INTO ${sql(tableName)} ${sql.insert(toSqlPayload(data)).returning("*")}`;
        return yield* oneRow(tableName, rows);
      }),
    createMany: ({ data }) =>
      Effect.gen(function* createManyGen() {
        if (data.length === 0) {
          return [];
        }
        const sql = yield* SqlClient;
        return [
          ...(yield* sql<Row>`INSERT INTO ${sql(tableName)} ${sql.insert(data.map(toSqlPayload)).returning("*")}`),
        ];
      }),
    delete: ({ where }) =>
      Effect.gen(function* deleteGen() {
        const sql = yield* SqlClient;
        const filter = whereFragment<Row>(sql, where);
        let query = sql<Row>`DELETE FROM ${sql(tableName)}`;
        if (filter) {
          query = sql`${query} WHERE ${filter}`;
        }
        return yield* oneRow(tableName, yield* withReturning(sql, query));
      }),
    deleteMany: (args) =>
      Effect.gen(function* deleteManyGen() {
        const sql = yield* SqlClient;
        const filter = whereFragment<Row>(sql, args?.where);
        let query = sql`DELETE FROM ${sql(tableName)}`;
        if (filter) {
          query = sql`${query} WHERE ${filter}`;
        }
        return yield* mutateManyCount(sql, query);
      }),
    exists: (args) =>
      Effect.gen(function* existsGen() {
        const sql = yield* SqlClient;
        const filter = whereFragment<Row>(sql, args?.where);
        let query = sql`SELECT 1 AS x FROM ${sql(tableName)}`;
        if (filter) {
          query = sql`${query} WHERE ${filter}`;
        }
        query = sql`${query} LIMIT 1`;
        return (yield* query).length > 0;
      }),
    findFirst: (args) =>
      selectRows(args, 1).pipe(Effect.map((rows) => rows[0] ?? null)),
    findMany: (args) => selectRows(args),
    findUnique: ({ where }) =>
      selectRows({ where }, 1).pipe(
        Effect.flatMap((rows) => oneRow(tableName, rows))
      ),
    paginate: (args) =>
      Effect.gen(function* paginateGen() {
        const totalCount = yield* countRows(args.where);
        if (args.skip !== undefined) {
          return yield* paginateWithSkip(
            { ...args, skip: args.skip },
            totalCount
          );
        }
        return yield* paginateWithCursor(args, totalCount);
      }),
    update: ({ data, where }) =>
      Effect.gen(function* updateGen() {
        const sql = yield* SqlClient;
        const filter = whereFragment<Row>(sql, where);
        let query = sql<Row>`UPDATE ${sql(tableName)} SET ${sql.update(toUpdatePayload(data))}`;
        if (filter) {
          query = sql`${query} WHERE ${filter}`;
        }
        return yield* oneRow(tableName, yield* withReturning(sql, query));
      }),
    updateMany: ({ data, where }) =>
      Effect.gen(function* updateManyGen() {
        const sql = yield* SqlClient;
        const filter = whereFragment<Row>(sql, where);
        let query = sql`UPDATE ${sql(tableName)} SET ${sql.update(toUpdatePayload(data))}`;
        if (filter) {
          query = sql`${query} WHERE ${filter}`;
        }
        return yield* mutateManyCount(sql, query);
      }),
    upsert: ({ create, update, where }) =>
      Effect.gen(function* upsertGen() {
        const columns = Object.keys(where);
        if (columns.length === 0) {
          return yield* Effect.fail(
            new ParanOrmError(
              "BAD_REQUEST",
              `${tableName}.upsert requires a conflict key`
            )
          );
        }
        const sql = yield* SqlClient;
        const rows = yield* withReturning(
          sql,
          sql<Row>`
            INSERT INTO ${sql(tableName)} ${sql.insert(toSqlPayload(create))}
            ON CONFLICT (${sql.csv(columns)}) DO UPDATE SET ${sql.update(toUpdatePayload(update))}
          `
        );
        return yield* oneRow(tableName, rows);
      }),
  };

  return model;
};

/**
 * Creates typed models from a database interface. Each method returns an Effect
 * that requires Effect `SqlClient` — provide any `@effect/sql-*` driver layer.
 */
export const paranorm = <TDB>(): ParanOrm<TDB> => {
  const models = new Map<string, ParanOrmModel<never>>();

  const getModel = (tableName: string): ParanOrmModel<never> => {
    let existing = models.get(tableName);
    if (existing === undefined) {
      existing = createModel(tableName);
      models.set(tableName, existing);
    }
    return existing;
  };

  const handler: ProxyHandler<ParanOrm<TDB>> = {
    get(_target, property) {
      if (Object.prototype.toString.call(property) === "[object Symbol]") {
        return null;
      }
      if (property === "then") {
        return null;
      }
      return getModel(String(property));
    },
  };

  // SAFETY: Proxy lazily materializes table models; empty target is never read directly.
  return new Proxy({} as ParanOrm<TDB>, handler);
};
