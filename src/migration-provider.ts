import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { diffSchemas, isDestructiveDiff } from "./diff.ts";
import { parseSchema } from "./parser.ts";
import type {
  ApplySchemaOptions,
  AuthoredSchema,
  ColumnDefinition,
  SchemaDiff,
  SchemaMacroRegistry,
  SchemaSource,
  TableDefinition,
} from "./types.ts";

/** SQL type rendering dialect. Both runtime clients are SQLite-backed. */
export type MigrationDialect = "sqlite";

export interface SchemaMigrationProviderOptions extends ApplySchemaOptions {
  schemas: SchemaSource[];
  macros?: SchemaMacroRegistry;
  /** SQL dialect used to render portable column types and generated defaults. */
  dialect?: MigrationDialect;
  /** SQL expression for generated string ids. Defaults to no database default. */
  cuidDefaultSql?: string;
  /** SQL expression for UUID v4 ids. Defaults to no database default on SQLite. */
  uuidDefaultSql?: string;
  /** Migrations history table name. */
  table?: string;
}

export type SchemaMigrationInput =
  | string
  | SchemaSource
  | { readonly source: string; readonly version?: string };

export interface CreateMigratorOptions extends Omit<SchemaMigrationProviderOptions, "schemas"> {}

export type MigrationPlanOperation = {
  kind:
    | "addTable"
    | "removeTable"
    | "addColumn"
    | "removeColumn"
    | "changeColumn"
    | "addUnique"
    | "removeUnique"
    | "addIndex"
    | "removeIndex";
  table: string;
  column?: string;
  columns?: string[];
  destructive: boolean;
};

export interface SchemaMigrationPlan {
  name: string;
  id: number;
  fromVersion?: string;
  toVersion: string;
  destructive: boolean;
  operations: MigrationPlanOperation[];
}

export interface MigrationSqlPreview extends SchemaMigrationPlan {
  statements: Array<{ sql: string; parameters: readonly unknown[] }>;
}

export type ParanOrmMigrator = {
  plan(): SchemaMigrationPlan[];
  validate(): SchemaMigrationPlan[];
  sql(): MigrationSqlPreview[];
  readonly loader: Migrator.Loader;
  readonly migrate: Effect.Effect<
    ReadonlyArray<readonly [id: number, name: string]>,
    Migrator.MigrationError | SqlError | Error,
    SqlClient
  >;
  readonly layer: Layer.Layer<never, Migrator.MigrationError | SqlError | Error, SqlClient>;
};

function normalizeSchemaSource(input: SchemaMigrationInput): SchemaSource {
  if (typeof input === "string") return { content: input };
  if ("content" in input)
    return {
      ...(input.name !== undefined ? { name: input.name } : {}),
      content: input.content,
    };
  return {
    ...(input.version !== undefined ? { name: input.version } : {}),
    content: input.source,
  };
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function constraintName(prefix: string, table: string, columns: string[]): string {
  return `${prefix}_${table}_${columns.join("_")}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function referentialAction(action: string): string {
  return action.toUpperCase();
}

function columnDataType(column: ColumnDefinition, dialect: MigrationDialect = "sqlite"): string {
  if (column.generation === "uuidv4") return "varchar(36)";
  if (column.generation === "auto-increment" && dialect === "sqlite") return "integer";
  if (column.kind === "binary") return "blob";
  return column.dataType;
}

function defaultExpression(
  column: ColumnDefinition,
  options: SchemaMigrationProviderOptions,
): string | undefined {
  const value = column.default;
  if (column.generation === "uuidv4") {
    return options.uuidDefaultSql ? `(${options.uuidDefaultSql})` : undefined;
  }
  if (column.generation === "cuid" && options.cuidDefaultSql) return `(${options.cuidDefaultSql})`;
  if (value?.kind === "sql") return `(${String(value.value)})`;
  if (value?.kind === "literal") {
    if (typeof value.value === "string") return `'${String(value.value).replaceAll("'", "''")}'`;
    if (typeof value.value === "boolean") return value.value ? "1" : "0";
    if (value.value === null) return "NULL";
    return String(value.value);
  }
  if (value?.kind === "keyword" && value.value === "now") return "CURRENT_TIMESTAMP";
  if (value?.kind === "keyword" && value.value !== "auto") return String(value.value);
  return undefined;
}

function columnSql(column: ColumnDefinition, options: SchemaMigrationProviderOptions): string {
  const parts = [quoteIdent(column.name), columnDataType(column, options.dialect ?? "sqlite")];
  if (column.primaryKey) parts.push("PRIMARY KEY");
  if (column.generation === "auto-increment") parts.push("AUTOINCREMENT");
  if (!column.nullable) parts.push("NOT NULL");
  const defaultValue = defaultExpression(column, options);
  if (defaultValue !== undefined) parts.push(`DEFAULT ${defaultValue}`);
  return parts.join(" ");
}

function createTableSql(table: TableDefinition, options: SchemaMigrationProviderOptions): string {
  const lines = Object.values(table.columns).map((column) => columnSql(column, options));
  for (const columns of table.uniqueConstraints)
    lines.push(
      `CONSTRAINT ${quoteIdent(constraintName("uq", table.name, columns))} UNIQUE (${columns.map(quoteIdent).join(", ")})`,
    );
  for (const column of Object.values(table.columns)) {
    if (!column.references) continue;
    const actions: string[] = [];
    if (column.references.onDelete)
      actions.push(`ON DELETE ${referentialAction(column.references.onDelete)}`);
    if (column.references.onUpdate)
      actions.push(`ON UPDATE ${referentialAction(column.references.onUpdate)}`);
    lines.push(
      `CONSTRAINT ${quoteIdent(constraintName("fk", table.name, [column.name]))} FOREIGN KEY (${quoteIdent(column.name)}) REFERENCES ${quoteIdent(column.references.table)} (${quoteIdent(column.references.column)})${actions.length ? ` ${actions.join(" ")}` : ""}`,
    );
  }
  return `CREATE TABLE ${quoteIdent(table.name)} (\n  ${lines.join(",\n  ")}\n)`;
}

function createIndexSql(table: string, column: string): string {
  return `CREATE INDEX ${quoteIdent(constraintName("idx", table, [column]))} ON ${quoteIdent(table)} (${quoteIdent(column)})`;
}

function schemaDiffStatements(
  diff: SchemaDiff,
  options: SchemaMigrationProviderOptions,
): Array<{ sql: string; parameters: readonly unknown[] }> {
  const statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const push = (sql: string) => statements.push({ sql, parameters: [] });

  for (const index of diff.removedIndexes)
    push(`DROP INDEX ${quoteIdent(constraintName("idx", index.table, [index.column]))}`);
  for (const constraint of diff.removedUniqueConstraints)
    push(
      `ALTER TABLE ${quoteIdent(constraint.table)} DROP CONSTRAINT ${quoteIdent(constraintName("uq", constraint.table, constraint.columns))}`,
    );
  for (const entry of diff.removedColumns) {
    if (entry.column.references)
      push(
        `ALTER TABLE ${quoteIdent(entry.table)} DROP CONSTRAINT ${quoteIdent(constraintName("fk", entry.table, [entry.column.name]))}`,
      );
    push(`ALTER TABLE ${quoteIdent(entry.table)} DROP COLUMN ${quoteIdent(entry.column.name)}`);
  }
  for (const table of diff.removedTables) push(`DROP TABLE ${quoteIdent(table.name)}`);
  for (const table of diff.addedTables) {
    push(createTableSql(table, options));
    for (const column of Object.values(table.columns))
      if (column.index && !column.unique) push(createIndexSql(table.name, column.name));
  }
  for (const entry of diff.addedColumns) {
    const { table, column } = entry;
    push(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${columnSql(column, options)}`);
    if (column.references) {
      const actions: string[] = [];
      if (column.references.onDelete)
        actions.push(`ON DELETE ${referentialAction(column.references.onDelete)}`);
      if (column.references.onUpdate)
        actions.push(`ON UPDATE ${referentialAction(column.references.onUpdate)}`);
      push(
        `ALTER TABLE ${quoteIdent(table)} ADD CONSTRAINT ${quoteIdent(constraintName("fk", table, [column.name]))} FOREIGN KEY (${quoteIdent(column.name)}) REFERENCES ${quoteIdent(column.references.table)} (${quoteIdent(column.references.column)})${actions.length ? ` ${actions.join(" ")}` : ""}`,
      );
    }
    if (column.index && !column.unique) push(createIndexSql(table, column.name));
  }
  for (const entry of diff.changedColumns) {
    const { table, from, to } = entry;
    if (
      from.primaryKey !== to.primaryKey ||
      (from.generation === "auto-increment") !== (to.generation === "auto-increment")
    )
      throw new Error(
        `Changing primary-key generation for ${table}.${to.name} is not supported automatically`,
      );
    const referenceChanged = JSON.stringify(from.references) !== JSON.stringify(to.references);
    if (from.references && referenceChanged)
      push(
        `ALTER TABLE ${quoteIdent(table)} DROP CONSTRAINT ${quoteIdent(constraintName("fk", table, [from.name]))}`,
      );
    if (
      columnDataType(from, options.dialect ?? "sqlite") !==
      columnDataType(to, options.dialect ?? "sqlite")
    )
      throw new Error(
        `Changing column type for ${table}.${to.name} is not supported automatically on SQLite`,
      );
    if (from.nullable !== to.nullable)
      throw new Error(
        `Changing nullability for ${table}.${to.name} is not supported automatically on SQLite`,
      );
    if (
      JSON.stringify(from.default) !== JSON.stringify(to.default) ||
      from.generation !== to.generation
    )
      throw new Error(
        `Changing defaults for ${table}.${to.name} is not supported automatically on SQLite`,
      );
    if (to.references && referenceChanged) {
      const actions: string[] = [];
      if (to.references.onDelete)
        actions.push(`ON DELETE ${referentialAction(to.references.onDelete)}`);
      if (to.references.onUpdate)
        actions.push(`ON UPDATE ${referentialAction(to.references.onUpdate)}`);
      push(
        `ALTER TABLE ${quoteIdent(table)} ADD CONSTRAINT ${quoteIdent(constraintName("fk", table, [to.name]))} FOREIGN KEY (${quoteIdent(to.name)}) REFERENCES ${quoteIdent(to.references.table)} (${quoteIdent(to.references.column)})${actions.length ? ` ${actions.join(" ")}` : ""}`,
      );
    }
  }
  for (const constraint of diff.addedUniqueConstraints)
    push(
      `CREATE UNIQUE INDEX ${quoteIdent(constraintName("uq", constraint.table, constraint.columns))} ON ${quoteIdent(constraint.table)} (${constraint.columns.map(quoteIdent).join(", ")})`,
    );
  for (const index of diff.addedIndexes) push(createIndexSql(index.table, index.column));
  return statements;
}

type InternalSchemaPlan = {
  plan: SchemaMigrationPlan;
  diff: SchemaDiff;
  statements: Array<{ sql: string; parameters: readonly unknown[] }>;
};

function operationsFromDiff(diff: SchemaDiff): MigrationPlanOperation[] {
  return [
    ...diff.addedTables.map((table) => ({
      kind: "addTable" as const,
      table: table.name,
      destructive: false,
    })),
    ...diff.removedTables.map((table) => ({
      kind: "removeTable" as const,
      table: table.name,
      destructive: true,
    })),
    ...diff.addedColumns.map((entry) => ({
      kind: "addColumn" as const,
      table: entry.table,
      column: entry.column.name,
      destructive: false,
    })),
    ...diff.removedColumns.map((entry) => ({
      kind: "removeColumn" as const,
      table: entry.table,
      column: entry.column.name,
      destructive: true,
    })),
    ...diff.changedColumns.map((entry) => ({
      kind: "changeColumn" as const,
      table: entry.table,
      column: entry.to.name,
      destructive: true,
    })),
    ...diff.addedUniqueConstraints.map((entry) => ({
      kind: "addUnique" as const,
      table: entry.table,
      columns: entry.columns,
      destructive: false,
    })),
    ...diff.removedUniqueConstraints.map((entry) => ({
      kind: "removeUnique" as const,
      table: entry.table,
      columns: entry.columns,
      destructive: true,
    })),
    ...diff.addedIndexes.map((entry) => ({
      kind: "addIndex" as const,
      table: entry.table,
      column: entry.column,
      destructive: false,
    })),
    ...diff.removedIndexes.map((entry) => ({
      kind: "removeIndex" as const,
      table: entry.table,
      column: entry.column,
      destructive: true,
    })),
  ];
}

function migrationKey(id: number, name: string): string {
  return `${id}_${name.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function createSchemaPlans(provider: SchemaMigrationProvider): InternalSchemaPlan[] {
  return provider.schemas.map((schema, index) => {
    const previous = provider.schemas[index - 1];
    const diff = diffSchemas(previous, schema);
    const operations = operationsFromDiff(diff);
    const name = provider.options.schemas[index]!.name ?? schema.version;
    const id = index + 1;
    return {
      diff,
      statements: schemaDiffStatements(diff, provider.options),
      plan: {
        name,
        id,
        ...(previous ? { fromVersion: previous.version } : {}),
        toVersion: schema.version,
        destructive: operations.some((operation) => operation.destructive),
        operations,
      },
    };
  });
}

/**
 * Creates a forward-only schema-diff migrator over Effect `SqlClient`.
 * Works with both Cloudflare D1 and Node SQLite (no transaction wrapper, so D1 is supported).
 */
export function createMigrator(
  schemas: readonly SchemaMigrationInput[],
  options: CreateMigratorOptions = {},
): ParanOrmMigrator {
  const provider = new SchemaMigrationProvider({
    schemas: schemas.map(normalizeSchemaSource),
    ...options,
  });
  const planned = createSchemaPlans(provider);
  const table = options.table ?? "paranorm_migrations";

  const pending = () => planned;

  const loader = Migrator.fromRecord(
    Object.fromEntries(
      planned.map((entry) => [
        migrationKey(entry.plan.id, entry.plan.name),
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          for (const statement of entry.statements)
            yield* sql.unsafe(statement.sql, statement.parameters);
        }),
      ]),
    ),
  );

  const migrate = Effect.gen(function* () {
    const sql = yield* SqlClient;
    if (!options.allowDestructive) {
      const destructive = planned.find((entry) => entry.plan.destructive);
      if (destructive)
        return yield* Effect.fail(
          new Error(
            `Migration ${destructive.plan.name} contains destructive changes; set allowDestructive to apply it`,
          ),
        );
    }

    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
)`);

    const completed = yield* sql<{ migration_id: number; name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id ASC
    `;
    const done = new Set(completed.map((row) => Number(row.migration_id)));
    const applied: Array<readonly [id: number, name: string]> = [];

    for (const entry of planned) {
      if (done.has(entry.plan.id)) continue;
      for (const statement of entry.statements)
        yield* sql.unsafe(statement.sql, statement.parameters);
      yield* sql.unsafe(`INSERT INTO ${quoteIdent(table)} (migration_id, name) VALUES (?, ?)`, [
        entry.plan.id,
        entry.plan.name,
      ]);
      applied.push([entry.plan.id, entry.plan.name]);
    }
    return applied;
  });

  return {
    plan: () => pending().map((entry) => entry.plan),
    validate: () => {
      const entries = pending();
      if (!options.allowDestructive) {
        const destructive = entries.find((entry) => entry.plan.destructive);
        if (destructive)
          throw new Error(
            `Migration ${destructive.plan.name} contains destructive changes; set allowDestructive to apply it`,
          );
      }
      return entries.map((entry) => entry.plan);
    },
    sql: () =>
      pending().map((entry) => ({
        ...entry.plan,
        statements: entry.statements,
      })),
    loader,
    migrate,
    layer: Layer.effectDiscard(migrate),
  };
}

export function applySchemaDiff(
  diff: SchemaDiff,
  options: SchemaMigrationProviderOptions,
): Effect.Effect<void, SqlError | Error, SqlClient> {
  return Effect.gen(function* () {
    if (isDestructiveDiff(diff) && !options.allowDestructive)
      return yield* Effect.fail(
        new Error(
          `Schema migration to ${diff.toVersion} contains destructive changes; set allowDestructive to apply it`,
        ),
      );
    const sql = yield* SqlClient;
    for (const statement of schemaDiffStatements(diff, options))
      yield* sql.unsafe(statement.sql, statement.parameters);
  });
}

export function migrateSchemasToLatest(
  options: SchemaMigrationProviderOptions,
): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError | Error,
  SqlClient
> {
  return createMigrator(options.schemas, options).migrate;
}

export class SchemaMigrationProvider {
  readonly schemas: AuthoredSchema[];
  readonly options: SchemaMigrationProviderOptions;

  constructor(options: SchemaMigrationProviderOptions) {
    if (!options.schemas.length)
      throw new Error("SchemaMigrationProvider requires at least one schema");
    this.options = options;
    this.schemas = options.schemas.map((source) =>
      parseSchema(source.content, {
        ...(options.macros !== undefined ? { macros: options.macros } : {}),
        ...(source.name !== undefined ? { sourceName: source.name } : {}),
      }),
    );
    for (let index = 1; index < this.schemas.length; index++) {
      if (
        this.schemas[index - 1]!.version.localeCompare(this.schemas[index]!.version, undefined, {
          numeric: true,
        }) >= 0
      )
        throw new Error("Schemas must be supplied in ascending version order");
    }
  }

  getMigrations(): Record<
    string,
    {
      id: number;
      name: string;
      up: Effect.Effect<void, SqlError | Error, SqlClient>;
    }
  > {
    return Object.fromEntries(
      createSchemaPlans(this).map((entry) => [
        entry.plan.name,
        {
          id: entry.plan.id,
          name: entry.plan.name,
          up: Effect.gen(function* () {
            const sql = yield* SqlClient;
            for (const statement of entry.statements)
              yield* sql.unsafe(statement.sql, statement.parameters);
          }),
        },
      ]),
    );
  }
}
