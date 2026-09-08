import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { diffSchemas, isDestructiveDiff } from "./diff.ts";
import { isYamlMapping, parseSchema } from "./parser.ts";
import type {
  ApplySchemaOptions,
  AuthoredSchema,
  ColumnDefinition,
  DefaultValue,
  SchemaDiff,
  SchemaMacroRegistry,
  SchemaSource,
  TableDefinition,
} from "./types.ts";

/** SQL type rendering dialect for migration DDL. */
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

export type CreateMigratorOptions = Omit<
  SchemaMigrationProviderOptions,
  "schemas"
>;

/** Options for rendering / applying a precomputed schema diff. */
export type ApplySchemaDiffOptions = Pick<
  SchemaMigrationProviderOptions,
  "allowDestructive" | "cuidDefaultSql" | "dialect" | "uuidDefaultSql"
>;

export interface MigrationPlanOperation {
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
}

export interface SchemaMigrationPlan {
  name: string;
  id: number;
  fromVersion?: string;
  toVersion: string;
  destructive: boolean;
  operations: MigrationPlanOperation[];
}

export interface MigrationSqlPreview extends SchemaMigrationPlan {
  statements: { sql: string; parameters: readonly unknown[] }[];
}

export interface ParanOrmMigrator {
  plan: () => SchemaMigrationPlan[];
  validate: () => SchemaMigrationPlan[];
  sql: () => MigrationSqlPreview[];
  readonly loader: Migrator.Loader;
  readonly migrate: Effect.Effect<
    readonly (readonly [id: number, name: string])[],
    Migrator.MigrationError | SqlError | Error,
    SqlClient
  >;
  readonly layer: Layer.Layer<
    never,
    Migrator.MigrationError | SqlError | Error,
    SqlClient
  >;
}

const isMigrationObject = (
  input: SchemaMigrationInput
): input is Exclude<SchemaMigrationInput, string> =>
  input !== null && Object(input) === input;

const isSchemaSourceInput = (
  input: SchemaMigrationInput
): input is SchemaSource => isMigrationObject(input) && "content" in input;

const isVersionedSourceInput = (
  input: SchemaMigrationInput
): input is { readonly source: string; readonly version?: string } =>
  isMigrationObject(input) && "source" in input && !("content" in input);

const normalizeSchemaSource = (input: SchemaMigrationInput): SchemaSource => {
  if (isSchemaSourceInput(input)) {
    const source: SchemaSource = { content: input.content };
    if (input.name !== undefined) {
      source.name = input.name;
    }
    return source;
  }
  if (isVersionedSourceInput(input)) {
    const source: SchemaSource = { content: input.source };
    if (input.version !== undefined) {
      source.name = input.version;
    }
    return source;
  }
  return { content: input };
};

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const constraintName = (
  prefix: string,
  table: string,
  columns: string[]
): string =>
  `${prefix}_${table}_${columns.join("_")}`.replaceAll(/[^A-Za-z0-9_]/gu, "_");

const referentialAction = (action: string): string => action.toUpperCase();

const columnDataType = (
  column: ColumnDefinition,
  dialect: MigrationDialect = "sqlite"
): string => {
  if (column.generation === "uuidv4") {
    return "varchar(36)";
  }
  if (column.generation === "auto-increment" && dialect === "sqlite") {
    return "integer";
  }
  if (column.kind === "binary") {
    return "blob";
  }
  return column.dataType;
};

const literalDefaultExpression = (
  value: Extract<DefaultValue, { kind: "literal" }>["value"]
): string => {
  if (value === null) {
    return "NULL";
  }
  if (value === true) {
    return "1";
  }
  if (value === false) {
    return "0";
  }
  if (Number.isFinite(value)) {
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
};

const defaultExpression = (
  column: ColumnDefinition,
  options: ApplySchemaDiffOptions
): string | undefined => {
  const value = column.default;
  if (column.generation === "uuidv4") {
    return options.uuidDefaultSql ? `(${options.uuidDefaultSql})` : undefined;
  }
  if (column.generation === "cuid" && options.cuidDefaultSql) {
    return `(${options.cuidDefaultSql})`;
  }
  if (value?.kind === "sql") {
    return `(${String(value.value)})`;
  }
  if (value?.kind === "literal") {
    return literalDefaultExpression(value.value);
  }
  if (value?.kind === "keyword" && value.value === "now") {
    return "CURRENT_TIMESTAMP";
  }
  if (value?.kind === "keyword" && value.value !== "auto") {
    return String(value.value);
  }
  return undefined;
};

const columnSql = (
  column: ColumnDefinition,
  options: ApplySchemaDiffOptions
): string => {
  const parts = [
    quoteIdent(column.name),
    columnDataType(column, options.dialect ?? "sqlite"),
  ];
  if (column.primaryKey) {
    parts.push("PRIMARY KEY");
  }
  if (column.generation === "auto-increment") {
    parts.push("AUTOINCREMENT");
  }
  if (!column.nullable) {
    parts.push("NOT NULL");
  }
  const defaultValue = defaultExpression(column, options);
  if (defaultValue !== undefined) {
    parts.push(`DEFAULT ${defaultValue}`);
  }
  return parts.join(" ");
};

const createTableSql = (
  table: TableDefinition,
  options: ApplySchemaDiffOptions
): string => {
  const lines = Object.values(table.columns).map((column) =>
    columnSql(column, options)
  );
  for (const columns of table.uniqueConstraints) {
    lines.push(
      `CONSTRAINT ${quoteIdent(constraintName("uq", table.name, columns))} UNIQUE (${columns.map(quoteIdent).join(", ")})`
    );
  }
  for (const column of Object.values(table.columns)) {
    if (!column.references) {
      continue;
    }
    const actions: string[] = [];
    if (column.references.onDelete) {
      actions.push(
        `ON DELETE ${referentialAction(column.references.onDelete)}`
      );
    }
    if (column.references.onUpdate) {
      actions.push(
        `ON UPDATE ${referentialAction(column.references.onUpdate)}`
      );
    }
    lines.push(
      `CONSTRAINT ${quoteIdent(constraintName("fk", table.name, [column.name]))} FOREIGN KEY (${quoteIdent(column.name)}) REFERENCES ${quoteIdent(column.references.table)} (${quoteIdent(column.references.column)})${actions.length ? ` ${actions.join(" ")}` : ""}`
    );
  }
  return `CREATE TABLE ${quoteIdent(table.name)} (\n  ${lines.join(",\n  ")}\n)`;
};

const createIndexSql = (table: string, column: string): string =>
  `CREATE INDEX ${quoteIdent(constraintName("idx", table, [column]))} ON ${quoteIdent(table)} (${quoteIdent(column)})`;

interface MigrationStatement {
  sql: string;
  parameters: readonly unknown[];
}

const pushRemovedStatements = (
  diff: SchemaDiff,
  push: (sql: string) => void
): void => {
  for (const index of diff.removedIndexes) {
    push(
      `DROP INDEX ${quoteIdent(constraintName("idx", index.table, [index.column]))}`
    );
  }
  for (const constraint of diff.removedUniqueConstraints) {
    push(
      `ALTER TABLE ${quoteIdent(constraint.table)} DROP CONSTRAINT ${quoteIdent(constraintName("uq", constraint.table, constraint.columns))}`
    );
  }
  for (const entry of diff.removedColumns) {
    if (entry.column.references) {
      push(
        `ALTER TABLE ${quoteIdent(entry.table)} DROP CONSTRAINT ${quoteIdent(constraintName("fk", entry.table, [entry.column.name]))}`
      );
    }
    push(
      `ALTER TABLE ${quoteIdent(entry.table)} DROP COLUMN ${quoteIdent(entry.column.name)}`
    );
  }
  for (const table of diff.removedTables) {
    push(`DROP TABLE ${quoteIdent(table.name)}`);
  }
};

const pushForeignKey = (
  table: string,
  column: ColumnDefinition,
  push: (sql: string) => void
): void => {
  if (!column.references) {
    return;
  }
  const actions: string[] = [];
  if (column.references.onDelete) {
    actions.push(`ON DELETE ${referentialAction(column.references.onDelete)}`);
  }
  if (column.references.onUpdate) {
    actions.push(`ON UPDATE ${referentialAction(column.references.onUpdate)}`);
  }
  push(
    `ALTER TABLE ${quoteIdent(table)} ADD CONSTRAINT ${quoteIdent(constraintName("fk", table, [column.name]))} FOREIGN KEY (${quoteIdent(column.name)}) REFERENCES ${quoteIdent(column.references.table)} (${quoteIdent(column.references.column)})${actions.length ? ` ${actions.join(" ")}` : ""}`
  );
};

const pushAddedTableStatements = (
  diff: SchemaDiff,
  options: ApplySchemaDiffOptions,
  push: (sql: string) => void
): void => {
  for (const table of diff.addedTables) {
    push(createTableSql(table, options));
    for (const column of Object.values(table.columns)) {
      if (column.index && !column.unique) {
        push(createIndexSql(table.name, column.name));
      }
    }
  }
};

const pushAddedColumnStatements = (
  diff: SchemaDiff,
  options: ApplySchemaDiffOptions,
  push: (sql: string) => void
): void => {
  for (const entry of diff.addedColumns) {
    const { table, column } = entry;
    push(
      `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${columnSql(column, options)}`
    );
    pushForeignKey(table, column, push);
    if (column.index && !column.unique) {
      push(createIndexSql(table, column.name));
    }
  }
};

const pushChangedColumnStatements = (
  diff: SchemaDiff,
  options: ApplySchemaDiffOptions,
  push: (sql: string) => void
): void => {
  for (const entry of diff.changedColumns) {
    const { table, from, to } = entry;
    if (
      from.primaryKey !== to.primaryKey ||
      (from.generation === "auto-increment") !==
        (to.generation === "auto-increment")
    ) {
      throw new Error(
        `Changing primary-key generation for ${table}.${to.name} is not supported automatically`
      );
    }
    const referenceChanged =
      JSON.stringify(from.references) !== JSON.stringify(to.references);
    if (from.references && referenceChanged) {
      push(
        `ALTER TABLE ${quoteIdent(table)} DROP CONSTRAINT ${quoteIdent(constraintName("fk", table, [from.name]))}`
      );
    }
    if (
      columnDataType(from, options.dialect ?? "sqlite") !==
      columnDataType(to, options.dialect ?? "sqlite")
    ) {
      throw new Error(
        `Changing column type for ${table}.${to.name} is not supported automatically on SQLite`
      );
    }
    if (from.nullable !== to.nullable) {
      throw new Error(
        `Changing nullability for ${table}.${to.name} is not supported automatically on SQLite`
      );
    }
    if (
      JSON.stringify(from.default) !== JSON.stringify(to.default) ||
      from.generation !== to.generation
    ) {
      throw new Error(
        `Changing defaults for ${table}.${to.name} is not supported automatically on SQLite`
      );
    }
    if (to.references && referenceChanged) {
      pushForeignKey(table, to, push);
    }
  }
};

const pushAddedConstraintStatements = (
  diff: SchemaDiff,
  push: (sql: string) => void
): void => {
  for (const constraint of diff.addedUniqueConstraints) {
    push(
      `CREATE UNIQUE INDEX ${quoteIdent(constraintName("uq", constraint.table, constraint.columns))} ON ${quoteIdent(constraint.table)} (${constraint.columns.map(quoteIdent).join(", ")})`
    );
  }
  for (const index of diff.addedIndexes) {
    push(createIndexSql(index.table, index.column));
  }
};

const schemaDiffStatements = (
  diff: SchemaDiff,
  options: ApplySchemaDiffOptions = {}
): MigrationStatement[] => {
  const statements: MigrationStatement[] = [];
  const push = (sql: string) => statements.push({ parameters: [], sql });

  pushRemovedStatements(diff, push);
  pushAddedTableStatements(diff, options, push);
  pushAddedColumnStatements(diff, options, push);
  pushChangedColumnStatements(diff, options, push);
  pushAddedConstraintStatements(diff, push);
  return statements;
};

interface InternalSchemaPlan {
  plan: SchemaMigrationPlan;
  diff: SchemaDiff;
  statements?: MigrationStatement[];
}

const resolvePlanStatements = (
  entry: InternalSchemaPlan,
  options: ApplySchemaDiffOptions
): MigrationStatement[] => {
  entry.statements ??= schemaDiffStatements(entry.diff, options);
  return entry.statements;
};

const operationsFromDiff = (diff: SchemaDiff): MigrationPlanOperation[] => [
  ...diff.addedTables.map((table) => ({
    destructive: false,
    kind: "addTable" as const,
    table: table.name,
  })),
  ...diff.removedTables.map((table) => ({
    destructive: true,
    kind: "removeTable" as const,
    table: table.name,
  })),
  ...diff.addedColumns.map((entry) => ({
    column: entry.column.name,
    destructive: false,
    kind: "addColumn" as const,
    table: entry.table,
  })),
  ...diff.removedColumns.map((entry) => ({
    column: entry.column.name,
    destructive: true,
    kind: "removeColumn" as const,
    table: entry.table,
  })),
  ...diff.changedColumns.map((entry) => ({
    column: entry.to.name,
    destructive: true,
    kind: "changeColumn" as const,
    table: entry.table,
  })),
  ...diff.addedUniqueConstraints.map((entry) => ({
    columns: entry.columns,
    destructive: false,
    kind: "addUnique" as const,
    table: entry.table,
  })),
  ...diff.removedUniqueConstraints.map((entry) => ({
    columns: entry.columns,
    destructive: true,
    kind: "removeUnique" as const,
    table: entry.table,
  })),
  ...diff.addedIndexes.map((entry) => ({
    column: entry.column,
    destructive: false,
    kind: "addIndex" as const,
    table: entry.table,
  })),
  ...diff.removedIndexes.map((entry) => ({
    column: entry.column,
    destructive: true,
    kind: "removeIndex" as const,
    table: entry.table,
  })),
];

const migrationKey = (id: number, name: string): string =>
  `${id}_${name.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;

const createSchemaPlans = (
  provider: SchemaMigrationProvider
): InternalSchemaPlan[] =>
  provider.schemas.map((schema, index) => {
    const previous = provider.schemas[index - 1];
    const diff = diffSchemas(previous, schema);
    const operations = operationsFromDiff(diff);
    const sourceMeta = provider.options.schemas[index];
    const name = sourceMeta?.name ?? schema.version;
    const id = index + 1;
    const plan: SchemaMigrationPlan = {
      destructive: operations.some((operation) => operation.destructive),
      id,
      name,
      operations,
      toVersion: schema.version,
    };
    if (previous) {
      plan.fromVersion = previous.version;
    }
    return {
      diff,
      plan,
    };
  });

interface SchemaParseOptions {
  macros?: SchemaMacroRegistry;
  sourceName?: string;
}

const parseSchemaSourceContent = (
  content: SchemaSource["content"],
  parseOptions: SchemaParseOptions
): AuthoredSchema => {
  if (isYamlMapping(content)) {
    return parseSchema(content, parseOptions);
  }
  if (String(content) !== content) {
    throw new Error("Schema source content must be a YAML string or mapping");
  }
  return parseSchema(content, parseOptions);
};

export class SchemaMigrationProvider {
  readonly schemas: AuthoredSchema[];
  readonly options: SchemaMigrationProviderOptions;

  constructor(options: SchemaMigrationProviderOptions) {
    if (!options.schemas.length) {
      throw new Error("SchemaMigrationProvider requires at least one schema");
    }
    this.options = options;
    this.schemas = options.schemas.map((source) => {
      const parseOptions: SchemaParseOptions = {};
      if (options.macros !== undefined) {
        parseOptions.macros = options.macros;
      }
      if (source.name !== undefined) {
        parseOptions.sourceName = source.name;
      }
      return parseSchemaSourceContent(source.content, parseOptions);
    });
    for (let index = 1; index < this.schemas.length; index += 1) {
      const prior = this.schemas[index - 1];
      const current = this.schemas[index];
      if (
        prior &&
        current &&
        prior.version.localeCompare(current.version, undefined, {
          numeric: true,
        }) >= 0
      ) {
        throw new Error("Schemas must be supplied in ascending version order");
      }
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
    const { options } = this;
    return Object.fromEntries(
      createSchemaPlans(this).map((entry) => [
        entry.plan.name,
        {
          id: entry.plan.id,
          name: entry.plan.name,
          up: Effect.gen(function* runMigration() {
            const sql = yield* SqlClient;
            for (const statement of resolvePlanStatements(entry, options)) {
              yield* sql.unsafe(statement.sql, statement.parameters);
            }
          }),
        },
      ])
    );
  }
}

/**
 * Creates a forward-only schema-diff migrator over Effect `SqlClient`.
 * Works with both Cloudflare D1 and Node SQLite (no transaction wrapper, so D1 is supported).
 */
export const createMigrator = (
  schemas: readonly SchemaMigrationInput[],
  options: CreateMigratorOptions = {}
): ParanOrmMigrator => {
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
        Effect.gen(function* runMigration() {
          const sql = yield* SqlClient;
          for (const statement of resolvePlanStatements(
            entry,
            provider.options
          )) {
            yield* sql.unsafe(statement.sql, statement.parameters);
          }
        }),
      ])
    )
  );

  const migrate = Effect.gen(function* runPendingMigrations() {
    const sql = yield* SqlClient;
    if (!options.allowDestructive) {
      const destructive = planned.find((entry) => entry.plan.destructive);
      if (destructive) {
        return yield* Effect.fail(
          new Error(
            `Migration ${destructive.plan.name} contains destructive changes; set allowDestructive to apply it`
          )
        );
      }
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
    const applied: (readonly [id: number, name: string])[] = [];

    for (const entry of planned) {
      if (done.has(entry.plan.id)) {
        continue;
      }
      for (const statement of resolvePlanStatements(entry, provider.options)) {
        yield* sql.unsafe(statement.sql, statement.parameters);
      }
      yield* sql.unsafe(
        `INSERT INTO ${quoteIdent(table)} (migration_id, name) VALUES (?, ?)`,
        [entry.plan.id, entry.plan.name]
      );
      applied.push([entry.plan.id, entry.plan.name]);
    }
    return applied;
  });

  return {
    layer: Layer.effectDiscard(migrate),
    loader,
    migrate,
    plan: () => pending().map((entry) => entry.plan),
    sql: () =>
      pending().map((entry) => ({
        ...entry.plan,
        statements: resolvePlanStatements(entry, provider.options),
      })),
    validate: () => {
      const entries = pending();
      if (!options.allowDestructive) {
        const destructive = entries.find((entry) => entry.plan.destructive);
        if (destructive) {
          throw new Error(
            `Migration ${destructive.plan.name} contains destructive changes; set allowDestructive to apply it`
          );
        }
      }
      return entries.map((entry) => entry.plan);
    },
  };
};

export const applySchemaDiff = (
  diff: SchemaDiff,
  options: ApplySchemaDiffOptions = {}
): Effect.Effect<void, SqlError | Error, SqlClient> =>
  Effect.gen(function* applySchemaDiffEffect() {
    if (isDestructiveDiff(diff) && !options.allowDestructive) {
      return yield* Effect.fail(
        new Error(
          `Schema migration to ${diff.toVersion} contains destructive changes; set allowDestructive to apply it`
        )
      );
    }
    const sql = yield* SqlClient;
    for (const statement of schemaDiffStatements(diff, options)) {
      yield* sql.unsafe(statement.sql, statement.parameters);
    }
  });

export const migrateSchemasToLatest = (
  options: SchemaMigrationProviderOptions
): Effect.Effect<
  readonly (readonly [id: number, name: string])[],
  Migrator.MigrationError | SqlError | Error,
  SqlClient
> => createMigrator(options.schemas, options).migrate;
