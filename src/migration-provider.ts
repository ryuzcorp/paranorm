import { sql, type ColumnDefinitionBuilder, type Kysely } from "kysely";
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
  type MigratorProps,
} from "kysely/migration";

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

export type MigrationDialect = "postgres" | "sqlite" | "mysql" | "mssql";

export interface SchemaMigrationProviderOptions extends ApplySchemaOptions {
  schemas: SchemaSource[];
  macros?: SchemaMacroRegistry;
  /** SQL dialect used to render portable column types and generated defaults. */
  dialect?: MigrationDialect;
  /** SQL expression for generated string ids. Defaults to no database default. */
  cuidDefaultSql?: string;
  /** SQL expression for UUID v4 ids. Defaults to gen_random_uuid(). */
  uuidDefaultSql?: string;
}

export type SchemaMigrationInput =
  | string
  | SchemaSource
  | { readonly source: string; readonly version?: string };

export interface CreateMigratorOptions
  extends Omit<MigratorProps, "db" | "provider">, Omit<SchemaMigrationProviderOptions, "schemas"> {}

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
  fromVersion?: string;
  toVersion: string;
  destructive: boolean;
  operations: MigrationPlanOperation[];
}

export interface MigrationSqlPreview extends SchemaMigrationPlan {
  statements: Array<{ sql: string; parameters: readonly unknown[] }>;
}

export type ParanOrmMigrator = Migrator & {
  plan(): Promise<SchemaMigrationPlan[]>;
  validate(): Promise<SchemaMigrationPlan[]>;
  sql(): Promise<MigrationSqlPreview[]>;
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

/**
 * Creates Kysely's native Migrator with a schema-diff provider. Migration names default
 * to each document's `_version`, while all standard Migrator methods remain available.
 */
export function createMigrator(
  db: Kysely<any>,
  schemas: readonly SchemaMigrationInput[],
  options: CreateMigratorOptions = {},
): ParanOrmMigrator {
  const { allowDestructive, macros, dialect, cuidDefaultSql, uuidDefaultSql, ...migratorOptions } =
    options;
  const provider = new SchemaMigrationProvider({
    schemas: schemas.map(normalizeSchemaSource),
    ...(allowDestructive !== undefined ? { allowDestructive } : {}),
    ...(macros !== undefined ? { macros } : {}),
    ...(dialect !== undefined ? { dialect } : {}),
    ...(cuidDefaultSql !== undefined ? { cuidDefaultSql } : {}),
    ...(uuidDefaultSql !== undefined ? { uuidDefaultSql } : {}),
  });
  const migrator = new Migrator({ db, provider, ...migratorOptions });
  const planned = createSchemaPlans(provider);
  const pending = async () => {
    const migrations = await migrator.getMigrations();
    const pendingNames = new Set(
      migrations.filter((migration) => !migration.executedAt).map((migration) => migration.name),
    );
    return planned.filter((entry) => pendingNames.has(entry.plan.name));
  };
  return Object.assign(migrator, {
    plan: async () => (await pending()).map((entry) => entry.plan),
    validate: async () => {
      const entries = await pending();
      if (!allowDestructive) {
        const destructive = entries.find((entry) => entry.plan.destructive);
        if (destructive)
          throw new Error(
            `Migration ${destructive.plan.name} contains destructive changes; set allowDestructive to apply it`,
          );
      }
      return entries.map((entry) => entry.plan);
    },
    sql: async () =>
      (await pending()).map((entry) => ({
        ...entry.plan,
        statements: schemaDiffBuilders(db, entry.diff, provider.options).map((builder) => {
          const compiled = builder.compile();
          return { sql: compiled.sql, parameters: compiled.parameters };
        }),
      })),
  });
}

function constraintName(prefix: string, table: string, columns: string[]): string {
  return `${prefix}_${table}_${columns.join("_")}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function applyReferenceActions(builder: any, column: ColumnDefinition): any {
  let result = builder;
  if (column.references?.onDelete) result = result.onDelete(column.references.onDelete);
  if (column.references?.onUpdate) result = result.onUpdate(column.references.onUpdate);
  return result;
}

function createIndexBuilder(db: Kysely<any>, table: string, column: string): any {
  return db.schema
    .createIndex(constraintName("idx", table, [column]))
    .on(table)
    .column(column);
}

function columnDataType(column: ColumnDefinition, dialect?: MigrationDialect): string {
  if (column.generation === "uuidv4") {
    if (dialect === "sqlite") return "varchar(36)";
    if (dialect === "mysql") return "char(36)";
    if (dialect === "mssql") return "uniqueidentifier";
    return "uuid";
  }
  if (column.generation === "auto-increment" && dialect === "sqlite") return "integer";
  if (column.kind === "json" && dialect === "postgres") return "jsonb";
  if (column.kind === "binary") {
    if (dialect === "postgres") return "bytea";
    if (dialect === "mssql") return "varbinary(max)";
    return "blob";
  }
  return column.dataType;
}

function defaultExpression(
  column: ColumnDefinition,
  options: SchemaMigrationProviderOptions,
): unknown {
  const value = column.default;
  if (column.generation === "uuidv4") {
    const generated =
      options.uuidDefaultSql ??
      (options.dialect === "mysql"
        ? "uuid()"
        : options.dialect === "mssql"
          ? "newid()"
          : options.dialect === "sqlite"
            ? undefined
            : "gen_random_uuid()");
    return generated ? sql.raw(generated) : undefined;
  }
  if (column.generation === "cuid" && options.cuidDefaultSql)
    return sql.raw(options.cuidDefaultSql);
  if (value?.kind === "sql") return sql.raw(String(value.value));
  if (value?.kind === "literal") return value.value;
  if (value?.kind === "keyword" && value.value === "now") return sql`CURRENT_TIMESTAMP`;
  if (value?.kind === "keyword" && value.value !== "auto") return sql.raw(String(value.value));
  return undefined;
}

function applyColumn(
  builder: ColumnDefinitionBuilder,
  column: ColumnDefinition,
  options: SchemaMigrationProviderOptions,
): ColumnDefinitionBuilder {
  let result = builder;
  if (column.primaryKey) result = result.primaryKey();
  if (!column.nullable) result = result.notNull();
  if (column.generation === "auto-increment") result = result.autoIncrement();
  const defaultValue = defaultExpression(column, options);
  if (defaultValue !== undefined) result = result.defaultTo(defaultValue as any);
  return result;
}

function createTableBuilder(
  db: Kysely<any>,
  table: TableDefinition,
  options: SchemaMigrationProviderOptions,
): any {
  let builder: any = db.schema.createTable(table.name);
  for (const column of Object.values(table.columns))
    builder = builder.addColumn(
      column.name,
      sql.raw(columnDataType(column, options.dialect)),
      (definition: ColumnDefinitionBuilder) => applyColumn(definition, column, options),
    );
  for (const columns of table.uniqueConstraints)
    builder = builder.addUniqueConstraint(
      constraintName("uq", table.name, columns),
      columns.map((column) => sql.ref(column)),
    );
  for (const column of Object.values(table.columns))
    if (column.references)
      builder = builder.addForeignKeyConstraint(
        constraintName("fk", table.name, [column.name]),
        [column.name],
        column.references.table,
        [column.references.column],
        (reference: any) => applyReferenceActions(reference, column),
      );
  return builder;
}

function schemaDiffBuilders(
  db: Kysely<any>,
  diff: SchemaDiff,
  options: SchemaMigrationProviderOptions,
): any[] {
  const builders: any[] = [];
  for (const index of diff.removedIndexes)
    builders.push(db.schema.dropIndex(constraintName("idx", index.table, [index.column])));
  for (const constraint of diff.removedUniqueConstraints)
    builders.push(
      db.schema
        .alterTable(constraint.table)
        .dropConstraint(constraintName("uq", constraint.table, constraint.columns)),
    );
  for (const entry of diff.removedColumns) {
    if (entry.column.references)
      builders.push(
        db.schema
          .alterTable(entry.table)
          .dropConstraint(constraintName("fk", entry.table, [entry.column.name])),
      );
    builders.push(db.schema.alterTable(entry.table).dropColumn(entry.column.name));
  }
  for (const table of diff.removedTables) builders.push(db.schema.dropTable(table.name));
  for (const table of diff.addedTables) {
    builders.push(createTableBuilder(db, table, options));
    for (const column of Object.values(table.columns))
      if (column.index && !column.unique)
        builders.push(createIndexBuilder(db, table.name, column.name));
  }
  for (const entry of diff.addedColumns) {
    const { table, column } = entry;
    builders.push(
      db.schema
        .alterTable(table)
        .addColumn(column.name, sql.raw(columnDataType(column, options.dialect)), (definition) =>
          applyColumn(definition, column, options),
        ),
    );
    if (column.references)
      builders.push(
        db.schema
          .alterTable(table)
          .addForeignKeyConstraint(
            constraintName("fk", table, [column.name]),
            [column.name],
            column.references.table,
            [column.references.column],
            (reference) => applyReferenceActions(reference, column),
          ),
      );
    if (column.index && !column.unique) builders.push(createIndexBuilder(db, table, column.name));
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
      builders.push(
        db.schema.alterTable(table).dropConstraint(constraintName("fk", table, [from.name])),
      );
    if (columnDataType(from, options.dialect) !== columnDataType(to, options.dialect))
      builders.push(
        db.schema
          .alterTable(table)
          .alterColumn(to.name, (column) =>
            column.setDataType(sql.raw(columnDataType(to, options.dialect))),
          ),
      );
    if (from.nullable !== to.nullable)
      builders.push(
        db.schema
          .alterTable(table)
          .alterColumn(to.name, (column) =>
            to.nullable ? column.dropNotNull() : column.setNotNull(),
          ),
      );
    if (
      JSON.stringify(from.default) !== JSON.stringify(to.default) ||
      from.generation !== to.generation
    ) {
      const value = defaultExpression(to, options);
      builders.push(
        db.schema
          .alterTable(table)
          .alterColumn(to.name, (column) =>
            value === undefined ? column.dropDefault() : column.setDefault(value as any),
          ),
      );
    }
    if (to.references && referenceChanged)
      builders.push(
        db.schema
          .alterTable(table)
          .addForeignKeyConstraint(
            constraintName("fk", table, [to.name]),
            [to.name],
            to.references.table,
            [to.references.column],
            (reference) => applyReferenceActions(reference, to),
          ),
      );
  }
  for (const constraint of diff.addedUniqueConstraints)
    builders.push(
      db.schema.alterTable(constraint.table).addUniqueConstraint(
        constraintName("uq", constraint.table, constraint.columns),
        constraint.columns.map((column) => sql.ref(column)),
      ),
    );
  for (const index of diff.addedIndexes)
    builders.push(createIndexBuilder(db, index.table, index.column));
  return builders;
}

type InternalSchemaPlan = { plan: SchemaMigrationPlan; diff: SchemaDiff };

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

function createSchemaPlans(provider: SchemaMigrationProvider): InternalSchemaPlan[] {
  return provider.schemas.map((schema, index) => {
    const previous = provider.schemas[index - 1];
    const diff = diffSchemas(previous, schema);
    const operations = operationsFromDiff(diff);
    return {
      diff,
      plan: {
        name: provider.options.schemas[index]!.name ?? schema.version,
        ...(previous ? { fromVersion: previous.version } : {}),
        toVersion: schema.version,
        destructive: operations.some((operation) => operation.destructive),
        operations,
      },
    };
  });
}

export async function applySchemaDiff(
  db: Kysely<any>,
  diff: SchemaDiff,
  options: SchemaMigrationProviderOptions,
): Promise<void> {
  if (isDestructiveDiff(diff) && !options.allowDestructive)
    throw new Error(
      `Schema migration to ${diff.toVersion} contains destructive changes; set allowDestructive to apply it`,
    );
  for (const builder of schemaDiffBuilders(db, diff, options)) await builder.execute();
}

export async function migrateSchemasToLatest(
  db: Kysely<any>,
  options: SchemaMigrationProviderOptions,
): Promise<MigrationResultSet> {
  return new Migrator({
    db,
    provider: new SchemaMigrationProvider(options),
  }).migrateToLatest();
}

export class SchemaMigrationProvider implements MigrationProvider {
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

  async getMigrations(): Promise<Record<string, Migration>> {
    return Object.fromEntries(
      this.schemas.map((schema, index) => {
        const previous = this.schemas[index - 1];
        const name = this.options.schemas[index]!.name ?? schema.version;
        const upDiff = diffSchemas(previous, schema);
        const downDiff = previous
          ? diffSchemas(schema, previous)
          : diffSchemas(schema, {
              version: "0.0.0",
              extends: [],
              extensions: {},
              tables: {},
              tableOrder: [],
            });
        return [
          name,
          {
            up: (db: Kysely<any>) => applySchemaDiff(db, upDiff, this.options),
            down: (db: Kysely<any>) =>
              applySchemaDiff(db, downDiff, {
                ...this.options,
                allowDestructive: true,
              }),
          } satisfies Migration,
        ];
      }),
    );
  }
}
