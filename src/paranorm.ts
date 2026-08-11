import { sql, type Insertable, type Kysely, type Selectable, type Updateable } from "kysely";

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
export class ParanORMError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "NOT_FOUND",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ParanORMError";
  }
}

type UniqueWhere<T> = { [K in keyof T]?: T[K] };
export interface ParanORMModel<Table> {
  findMany<const Args extends FindArgs<Selectable<Table>> | undefined = undefined>(
    args?: Args,
  ): Promise<SelectedResult<Selectable<Table>, Args>[]>;
  findFirst<const Args extends FindArgs<Selectable<Table>> | undefined = undefined>(
    args?: Args,
  ): Promise<SelectedResult<Selectable<Table>, Args> | null>;
  findUnique(args: { where: UniqueWhere<Selectable<Table>> }): Promise<Selectable<Table>>;
  create(args: { data: Insertable<Table> }): Promise<Selectable<Table>>;
  createMany(args: { data: readonly Insertable<Table>[] }): Promise<Selectable<Table>[]>;
  update(args: {
    where: UniqueWhere<Selectable<Table>>;
    data: Updateable<Table>;
  }): Promise<Selectable<Table>>;
  updateMany(args: {
    where?: WhereClause<Selectable<Table>>;
    data: Updateable<Table>;
  }): Promise<number>;
  delete(args: { where: UniqueWhere<Selectable<Table>> }): Promise<Selectable<Table>>;
  deleteMany(args?: { where?: WhereClause<Selectable<Table>> }): Promise<number>;
  upsert(args: {
    where: UniqueWhere<Selectable<Table>>;
    create: Insertable<Table>;
    update: Updateable<Table>;
  }): Promise<Selectable<Table>>;
  count(args?: { where?: WhereClause<Selectable<Table>> }): Promise<number>;
  exists(args?: { where?: WhereClause<Selectable<Table>> }): Promise<boolean>;
  paginate<const Args extends PaginateArgs<Selectable<Table>>>(
    args: Args,
  ): Promise<PaginationResult<SelectedResult<Selectable<Table>, Args>>>;
}
export type ParanORM<TDB> = { [K in keyof TDB]: ParanORMModel<TDB[K]> };

function escapeLike(value: unknown): string {
  return String(value).replace(/[\\%_]/g, (character) => `\\${character}`);
}
function likeExpr(field: string, pattern: string) {
  return sql`${sql.ref(field)} like ${pattern} escape '\\'`;
}

function opToExpr(eb: any, field: string, operation: string, value: any): any {
  switch (operation) {
    case "equals":
      return eb(field, "=", value);
    case "not":
      return eb(field, "!=", value);
    case "in":
      return eb(field, "in", value);
    case "notIn":
      return eb(field, "not in", value);
    case "lt":
      return eb(field, "<", value);
    case "lte":
      return eb(field, "<=", value);
    case "gt":
      return eb(field, ">", value);
    case "gte":
      return eb(field, ">=", value);
    case "contains":
      return likeExpr(field, `%${escapeLike(value)}%`);
    case "startsWith":
      return likeExpr(field, `${escapeLike(value)}%`);
    case "endsWith":
      return likeExpr(field, `%${escapeLike(value)}`);
    case "isNull":
      return value ? eb(field, "is", null) : eb(field, "is not", null);
    default:
      return eb(field, "=", value);
  }
}
function fieldToExprs(eb: any, field: string, filter: any): any[] {
  if (filter === undefined) return [];
  if (
    filter === null ||
    typeof filter !== "object" ||
    filter instanceof Date ||
    Array.isArray(filter)
  )
    return [eb(field, "=", filter)];
  return Object.entries(filter).map(([operation, value]) => opToExpr(eb, field, operation, value));
}
function clauseToExprs(eb: any, clause: Record<string, any>): any[] {
  const expressions: any[] = [];
  for (const [field, filter] of Object.entries(clause)) {
    if (filter === undefined) continue;
    if (field === "AND" && Array.isArray(filter)) {
      const nested = filter.flatMap((item) => clauseToExprs(eb, item));
      expressions.push(nested.length ? eb.and(nested) : eb.lit(1));
    } else if (field === "OR" && Array.isArray(filter)) {
      expressions.push(
        eb.or(
          filter.map((item) => {
            const nested = clauseToExprs(eb, item);
            return nested.length ? eb.and(nested) : eb.lit(1);
          }),
        ),
      );
    } else if (field === "NOT") {
      const nested = clauseToExprs(eb, filter as Record<string, any>);
      expressions.push(eb.not(nested.length ? eb.and(nested) : eb.lit(1)));
    } else expressions.push(...fieldToExprs(eb, field, filter));
  }
  return expressions;
}
function applyWhere(qb: any, where: Record<string, any>): any {
  for (const [field, filter] of Object.entries(where)) {
    if (filter === undefined) continue;
    if (field === "AND" && Array.isArray(filter)) {
      for (const clause of filter) qb = applyWhere(qb, clause);
    } else if (field === "OR" && Array.isArray(filter))
      qb = qb.where((eb: any) =>
        eb.or(
          filter.map((clause) => {
            const nested = clauseToExprs(eb, clause);
            return nested.length ? eb.and(nested) : eb.lit(1);
          }),
        ),
      );
    else if (field === "NOT")
      qb = qb.where((eb: any) => {
        const nested = clauseToExprs(eb, filter as Record<string, any>);
        return eb.not(nested.length ? eb.and(nested) : eb.lit(1));
      });
    else if (
      filter !== null &&
      typeof filter === "object" &&
      !Array.isArray(filter) &&
      !(filter instanceof Date)
    )
      for (const [operation, value] of Object.entries(filter))
        qb = qb.where((eb: any) => opToExpr(eb, field, operation, value));
    else qb = qb.where(field, "=", filter);
  }
  return qb;
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
    throw new ParanORMError("BAD_REQUEST", "Invalid pagination cursor", {
      cause,
    });
  }
}
function applyCursorWhere(
  query: any,
  cursor: Record<string, any>,
  orderBy: OrderByClause<any>[],
  direction: "after" | "before",
): any {
  const entries = orderBy.flatMap((order) => Object.entries(order)) as [string, "asc" | "desc"][];
  if (!entries.length) return query;
  return query.where((eb: any) =>
    eb.or(
      entries.map(([column, order], index) => {
        const parts = entries
          .slice(0, index)
          .map(([previous]) => eb(previous, "=", cursor[previous]));
        const forward = direction === "after" ? order === "asc" : order === "desc";
        parts.push(eb(column, forward ? ">" : "<", cursor[column]));
        return parts.length === 1 ? parts[0] : eb.and(parts);
      }),
    ),
  );
}

function createModel<Table>(db: Kysely<any>, tableName: string): ParanORMModel<Table> {
  type Row = Selectable<Table>;
  function selectedColumns(select?: SelectClause<Row>): string[] {
    return select
      ? Object.entries(select)
          .filter(([, enabled]) => enabled)
          .map(([column]) => column)
      : [];
  }
  function buildSelect(args?: FindArgs<Row>, limitOverride?: number): any {
    let query: any = db.selectFrom(tableName);
    if (args?.where) query = applyWhere(query, args.where as Record<string, any>);
    if (args?.orderBy)
      for (const order of args.orderBy)
        for (const [column, direction] of Object.entries(order))
          if (direction) query = query.orderBy(column, direction);
    const limit = limitOverride ?? args?.take;
    if (limit !== undefined) query = query.limit(limit);
    if (args?.skip !== undefined) query = query.offset(args.skip);
    const columns = selectedColumns(args?.select);
    return columns.length ? query.select(columns) : query.selectAll();
  }
  function buildCount(where?: WhereClause<Row>): any {
    let query: any = db.selectFrom(tableName).select((eb: any) => eb.fn.countAll().as("n"));
    if (where) query = applyWhere(query, where as Record<string, any>);
    return query;
  }
  async function run(args?: FindArgs<Row>, limitOverride?: number): Promise<any[]> {
    return buildSelect(args, limitOverride).execute();
  }
  async function oneMutation(query: any): Promise<Row> {
    const row = await query.returningAll().executeTakeFirst();
    if (row == null) throw new ParanORMError("NOT_FOUND", `${tableName}: record not found`);
    return row as Row;
  }
  const model = {
    findMany: (args?: FindArgs<Row>) => run(args),
    findFirst: async (args?: FindArgs<Row>) => (await run(args, 1))[0] ?? null,
    findUnique: async ({ where }: { where: UniqueWhere<Row> }) => {
      let query: any = db.selectFrom(tableName).selectAll();
      query = applyWhere(query, where as Record<string, any>);
      const row = await query.executeTakeFirst();
      if (row == null) throw new ParanORMError("NOT_FOUND", `${tableName}: record not found`);
      return row as Row;
    },
    create: ({ data }: { data: Insertable<Table> }) =>
      oneMutation(db.insertInto(tableName).values(data as any)),
    createMany: async ({ data }: { data: readonly Insertable<Table>[] }) => {
      if (!data.length) return [];
      return db
        .insertInto(tableName)
        .values(data as any)
        .returningAll()
        .execute() as Promise<Row[]>;
    },
    update: ({ where, data }: { where: UniqueWhere<Row>; data: Updateable<Table> }) => {
      let query: any = db.updateTable(tableName).set(data as any);
      query = applyWhere(query, where as Record<string, any>);
      return oneMutation(query);
    },
    updateMany: async ({ where, data }: { where?: WhereClause<Row>; data: Updateable<Table> }) => {
      let query: any = db.updateTable(tableName).set(data as any);
      if (where) query = applyWhere(query, where as Record<string, any>);
      return Number((await query.executeTakeFirst()).numUpdatedRows);
    },
    delete: ({ where }: { where: UniqueWhere<Row> }) => {
      let query: any = db.deleteFrom(tableName);
      query = applyWhere(query, where as Record<string, any>);
      return oneMutation(query);
    },
    deleteMany: async (args?: { where?: WhereClause<Row> }) => {
      let query: any = db.deleteFrom(tableName);
      if (args?.where) query = applyWhere(query, args.where as Record<string, any>);
      return Number((await query.executeTakeFirst()).numDeletedRows);
    },
    upsert: ({
      where,
      create,
      update,
    }: {
      where: UniqueWhere<Row>;
      create: Insertable<Table>;
      update: Updateable<Table>;
    }) => {
      const columns = Object.keys(where);
      if (!columns.length)
        throw new ParanORMError("BAD_REQUEST", `${tableName}.upsert requires a conflict key`);
      const query = db
        .insertInto(tableName)
        .values(create as any)
        .onConflict((conflict: any) => conflict.columns(columns).doUpdateSet(update as any));
      return oneMutation(query);
    },
    count: async (args?: { where?: WhereClause<Row> }) =>
      Number((await buildCount(args?.where).executeTakeFirstOrThrow()).n),
    exists: async (args?: { where?: WhereClause<Row> }) => {
      let query: any = db
        .selectFrom(tableName)
        .select((eb: any) => eb.lit(1).as("x"))
        .limit(1);
      if (args?.where) query = applyWhere(query, args.where as Record<string, any>);
      return (await query.executeTakeFirst()) != null;
    },
    paginate: async (args: PaginateArgs<Row>) => {
      const { take, skip, after, before, orderBy, where, ...rest } = args;
      const count = Number((await buildCount(where).executeTakeFirstOrThrow()).n);
      if (skip !== undefined) {
        const data = await run({
          ...rest,
          ...(where !== undefined ? { where } : {}),
          orderBy,
          take,
          skip,
        });
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
      const direction = before !== undefined ? "before" : "after";
      let query: any = db.selectFrom(tableName);
      if (where) query = applyWhere(query, where as Record<string, any>);
      if (after) query = applyCursorWhere(query, decodeCursor(after), orderBy, "after");
      else if (before) query = applyCursorWhere(query, decodeCursor(before), orderBy, "before");
      const effective =
        direction === "before"
          ? orderBy.map((order) =>
              Object.fromEntries(
                Object.entries(order).map(([column, value]) => [
                  column,
                  value === "asc" ? "desc" : "asc",
                ]),
              ),
            )
          : orderBy;
      for (const order of effective)
        for (const [column, value] of Object.entries(order))
          if (value) query = query.orderBy(column, value);
      const columns = selectedColumns(rest.select);
      query = columns.length ? query.select(columns) : query.selectAll();
      let rows: any[] = await query.limit(take + 1).execute();
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
    },
  };
  return model as ParanORMModel<Table>;
}

export function createParanORM<TDB>(db: Kysely<TDB>): ParanORM<TDB> {
  const models: Record<string, unknown> = {};
  const model = (tableName: string) => {
    models[tableName] ??= createModel(db as Kysely<any>, tableName);
    return models[tableName];
  };

  // Kysely's DB generic is erased at runtime. A proxy lets table properties create
  // their model lazily while TypeScript restricts them to keyof TDB.
  return new Proxy(models, {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      if (property === "then" && !(property in target)) return undefined;
      return model(property);
    },
  }) as ParanORM<TDB>;
}
