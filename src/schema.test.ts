import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";

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

describe("schema migrations", () => {
  test("diffs consecutive schemas", () => {
    const diff = diffSchemas(parseSchema(v1), parseSchema(v2));
    expect(diff.addedColumns.map(({ table, column }) => `${table}.${column.name}`)).toEqual([
      "entries.title",
    ]);
    expect(diff.removedColumns).toHaveLength(0);
  });

  test("exposes one migration per schema version", () => {
    const provider = new SchemaMigrationProvider({
      schemas: [{ content: v1 }, { name: "002_v2", content: v2 }],
    });
    const migrations = provider.getMigrations();
    expect(Object.keys(migrations)).toEqual(["1.0.0", "002_v2"]);
    expect(migrations["002_v2"]!.id).toBe(2);
  });

  test("renders sqlite migration SQL", () => {
    const authored = defineSchema(
      `_version: "1.0.0"\nrecords:\n  id: id(bigint)\n  payload: json\n  bytes: binary\n`,
    );
    const sqliteSql = createMigrator([authored], { dialect: "sqlite" }).sql();
    const sqliteStatement = sqliteSql[0]!.statements[0]!.sql;
    expect(sqliteStatement).toContain('"id" integer');
    expect(sqliteStatement).toContain('"payload" json');
    expect(sqliteStatement).toContain('"bytes" blob');
  });

  test("creates Effect migrator with schema sugar", async () => {
    const first = defineSchema(
      `_version: "1.0.0"\npeople:\n  id: id(varchar(64))\n  name: string\n`,
    );
    const second = defineSchema(
      `_version: "2.0.0"\npeople:\n  id: id(varchar(64))\n  name: string\n  email: string? index\n`,
    );
    const migrator = createMigrator([first, second], {
      table: "paranorm_migration",
    });

    const plan = migrator.plan();
    expect(plan).toHaveLength(2);
    expect(plan[1]).toMatchObject({
      name: "2.0.0",
      destructive: false,
      operations: [{ kind: "addColumn", table: "people", column: "email" }],
    });
    expect(migrator.validate()).toEqual(plan);
    const preview = migrator.sql();
    expect(
      preview.flatMap((migration) => migration.statements.map((statement) => statement.sql)),
    ).toContain('ALTER TABLE "people" ADD COLUMN "email" varchar(255)');

    await Effect.runPromise(
      Effect.gen(function* () {
        const applied = yield* migrator.migrate;
        expect(applied).toEqual([
          [1, "1.0.0"],
          [2, "2.0.0"],
        ]);
        expect(migrator.plan()).toHaveLength(2);

        const sql = yield* SqliteClient.SqliteClient;
        const columns = yield* sql<{ name: string }>`pragma table_info('people')`;
        expect(columns.map((column) => column.name)).toEqual(["id", "name", "email"]);

        const again = yield* migrator.migrate;
        expect(again).toEqual([]);
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
        Effect.scoped,
      ),
    );
  });
});
