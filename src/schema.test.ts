import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { Kysely, SqliteDialect } from "kysely";

import {
  createMigrator,
  defineSchema,
  diffSchemas,
  parseColumn,
  parseSchema,
  SchemaMigrationProvider,
} from "./index.ts";

const v1 = `
_version: "1.0.0"
projects:
  id: id
  slug: string unique
  _relations:
    entries: has_many=entries
entries:
  id: id(uuidv4)
  project_id: string references=projects.id unique=[entries.project_id, entries.slug]
  slug: string unique=[entries.project_id, entries.slug]
  author_id: string
  _relations:
    project: belongs_to=projects
  _access:
    create: authenticated
    update: owner
    owner_column: author_id
`;

const v2 = v1
  .replace('"1.0.0"', '"2.0.0"')
  .replace("  author_id: string", '  author_id: string\n  title: string default="Untitled"');

describe("schema authoring", () => {
  test("parses types, constraints, relations, access, and dependency order", () => {
    const schema = parseSchema(v1);
    expect(schema.tableOrder).toEqual(["projects", "entries"]);
    expect(schema.tables.entries!.columns.id!.generation).toBe("uuidv4");
    expect(schema.tables.entries!.uniqueConstraints).toEqual([["project_id", "slug"]]);
    expect(schema.tables.entries!.relations.project!.column).toBe("project_id");
    expect(schema.tables.entries!.access).toMatchObject({
      list: "public",
      create: "authenticated",
      update: "owner",
      ownerColumn: "author_id",
    });
  });

  test("parses parameterized and nullable columns", () => {
    expect(parseColumn("id", "id(varchar(64))")).toMatchObject({
      dataType: "varchar(64)",
      primaryKey: true,
      generation: "cuid",
    });
    expect(parseColumn("amount", "decimal(10, 2)? default=12.5")).toMatchObject({
      kind: "decimal",
      dataType: "decimal(10,2)",
      nullable: true,
      default: { kind: "literal", value: 12.5 },
    });
  });

  test("rejects invalid owner access", () => {
    expect(() =>
      parseSchema(`_version: "1.0.0"\nthings:\n  id: id\n  _access:\n    update: owner\n`),
    ).toThrow("requires owner_column");
  });

  test("requires underscored metadata", () => {
    expect(() => parseSchema(`version: "1.0.0"\nthings:\n  id: id\n`)).toThrow("_version");
  });

  test("reports YAML source locations for schema errors", () => {
    expect(() =>
      parseSchema(`_version: "1.0.0"\nentries:\n  id: id\n  author_id: references=missing.id\n`, {
        sourceName: "cms-schema.yaml",
      }),
    ).toThrow("cms-schema.yaml:4:3");
  });

  test("expands the complete auth macro", () => {
    const schema = parseSchema(
      `_version: "1.0.0"\n_extends: [auth]\n_auth:\n  roles: [user, admin]\n  api_keys: true\nposts:\n  id: id\n  user_id: string references=user.id\n`,
    );
    expect(schema.tables.user!.columns).toHaveProperty("banned");
    expect(schema.tables.user!.columns.role).toMatchObject({
      enumValues: ["user", "admin"],
      multiple: true,
    });
    expect(schema.tables.session!.columns.userId).toMatchObject({
      index: true,
      references: { table: "user", column: "id", onDelete: "cascade" },
    });
    expect(schema.tables.apikey!.columns).toHaveProperty("rateLimitEnabled");
    expect(schema.tableOrder.indexOf("user")).toBeLessThan(schema.tableOrder.indexOf("posts"));
  });

  test("expands files and attachment pivots", () => {
    const schema = parseSchema(
      `_version: "1.0.0"\n_extends: [auth, files]\n_files:\n  attach_to: [posts]\nposts:\n  id: id(bigint)\n`,
    );
    expect(schema.tables.file!.columns.userId!.references).toMatchObject({
      table: "user",
      onDelete: "set null",
    });
    expect(schema.tables.posts_file!.columns.entityId).toMatchObject({
      dataType: "bigint",
      index: true,
      references: { table: "posts", column: "id", onDelete: "cascade" },
    });
    expect(schema.tables.posts_file!.relations).toHaveProperty("file");
  });

  test("supports ownerless files without auth", () => {
    const schema = parseSchema(
      `_version: "1.0.0"\n_extends: [files]\n_files:\n  owner: false\nassets:\n  id: id\n`,
    );
    expect(schema.tables.file!.columns.userId).toBeUndefined();
  });
});

function migrationDatabase() {
  const sqlite = new Database(":memory:");
  const database = {
    close: () => sqlite.close(),
    prepare: (query: string) => {
      const statement = sqlite.prepare(query);
      return {
        reader: /^\s*(select|pragma|with)\b/i.test(query) || /\breturning\b/i.test(query),
        all: (parameters: readonly unknown[]) => statement.all(...(parameters as never[])),
        run: (parameters: readonly unknown[]) => statement.run(...(parameters as never[])),
        iterate: (parameters: readonly unknown[]) => statement.iterate(...(parameters as never[])),
      };
    },
  };
  const config = { database } as unknown as ConstructorParameters<typeof SqliteDialect>[0];
  return { sqlite, db: new Kysely<Record<string, never>>({ dialect: new SqliteDialect(config) }) };
}

describe("schema migrations", () => {
  test("diffs consecutive schemas", () => {
    const diff = diffSchemas(parseSchema(v1), parseSchema(v2));
    expect(diff.addedColumns.map(({ table, column }) => `${table}.${column.name}`)).toEqual([
      "entries.title",
    ]);
    expect(diff.removedColumns).toHaveLength(0);
  });

  test("exposes one Kysely migration per schema version", async () => {
    const provider = new SchemaMigrationProvider({
      schemas: [{ content: v1 }, { name: "002_v2", content: v2 }],
    });
    const migrations = await provider.getMigrations();
    expect(Object.keys(migrations)).toEqual(["1.0.0", "002_v2"]);
    expect(migrations["002_v2"]!.up).toBeFunction();
    expect(migrations["002_v2"]!.down).toBeFunction();
  });

  test("renders dialect-aware migration SQL", async () => {
    const authored = defineSchema(
      `_version: "1.0.0"\nrecords:\n  id: id(bigint)\n  payload: json\n  bytes: binary\n`,
    );
    const sqliteSetup = migrationDatabase();
    const sqliteSql = await createMigrator(sqliteSetup.db, [authored], { dialect: "sqlite" }).sql();
    const sqliteStatement = sqliteSql[0]!.statements[0]!.sql;
    expect(sqliteStatement).toContain('"id" integer');
    expect(sqliteStatement).toContain('"payload" json');
    expect(sqliteStatement).toContain('"bytes" blob');
    await sqliteSetup.db.destroy();

    const postgresSetup = migrationDatabase();
    const postgresSql = await createMigrator(postgresSetup.db, [authored], {
      dialect: "postgres",
    }).sql();
    const postgresStatement = postgresSql[0]!.statements[0]!.sql;
    expect(postgresStatement).toContain('"id" bigint');
    expect(postgresStatement).toContain('"payload" jsonb');
    expect(postgresStatement).toContain('"bytes" bytea');
    await postgresSetup.db.destroy();
  });

  test("creates Kysely Migrator with schema sugar", async () => {
    const first = defineSchema(
      `_version: "1.0.0"\npeople:\n  id: id(varchar(64))\n  name: string\n`,
    );
    const second = defineSchema(
      `_version: "2.0.0"\npeople:\n  id: id(varchar(64))\n  name: string\n  email: string? index\n`,
    );
    const { db, sqlite } = migrationDatabase();
    const migrator = createMigrator(db, [first, second], {
      migrationTableName: "kysola_migration",
      migrationLockTableName: "kysola_migration_lock",
    });

    const plan = await migrator.plan();
    expect(plan).toHaveLength(2);
    expect(plan[1]).toMatchObject({
      name: "2.0.0",
      destructive: false,
      operations: [{ kind: "addColumn", table: "people", column: "email" }],
    });
    expect(await migrator.validate()).toEqual(plan);
    const preview = await migrator.sql();
    expect(
      preview.flatMap((migration) => migration.statements.map((statement) => statement.sql)),
    ).toContain('alter table "people" add column "email" varchar(255)');

    const latest = await migrator.migrateToLatest();
    expect(latest.error).toBeUndefined();
    expect(latest.results?.map((result) => [result.migrationName, result.status])).toEqual([
      ["1.0.0", "Success"],
      ["2.0.0", "Success"],
    ]);
    expect(await migrator.plan()).toEqual([]);
    expect(
      sqlite
        .query<{ name: string }, []>("pragma table_info('people')")
        .all()
        .map((column) => column.name),
    ).toEqual(["id", "name", "email"]);

    const down = await migrator.migrateDown();
    expect(down.error).toBeUndefined();
    expect(down.results?.[0]).toMatchObject({
      migrationName: "2.0.0",
      direction: "Down",
      status: "Success",
    });
    expect(
      sqlite
        .query<{ name: string }, []>("pragma table_info('people')")
        .all()
        .map((column) => column.name),
    ).toEqual(["id", "name"]);

    await db.destroy();
  });
});
