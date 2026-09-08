import { describe, expect, test } from "bun:test";

import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";

import {
  applySchemaDiff,
  columnChanged,
  createMigrator,
  defineSchema,
  diffSchemas,
  isDestructiveDiff,
  migrateSchemasToLatest,
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
  .replace(
    "  author_id: string",
    '  author_id: string\n  title: string default="Untitled"'
  );

describe("schema authoring", () => {
  test("parses types, constraints, relations, access, and dependency order", () => {
    const schema = parseSchema(v1);
    expect(schema.tableOrder).toEqual(["projects", "entries"]);
    const { entries } = schema.tables;
    expect(entries).toBeDefined();
    if (!entries) {
      throw new Error("expected entries table");
    }
    const idColumn = entries.columns.id;
    expect(idColumn).toBeDefined();
    if (!idColumn) {
      throw new Error("expected id column");
    }
    expect(idColumn.generation).toBe("uuidv4");
    expect(entries.uniqueConstraints).toEqual([["project_id", "slug"]]);
    const projectRelation = entries.relations.project;
    expect(projectRelation).toBeDefined();
    if (!projectRelation) {
      throw new Error("expected project relation");
    }
    expect(projectRelation.column).toBe("project_id");
    expect(entries.access).toMatchObject({
      create: "authenticated",
      list: "public",
      ownerColumn: "author_id",
      update: "owner",
    });
  });

  test("parses parameterized and nullable columns", () => {
    expect(parseColumn("id", "id(varchar(64))")).toMatchObject({
      dataType: "varchar(64)",
      generation: "cuid",
      primaryKey: true,
    });
    expect(parseColumn("amount", "decimal(10, 2)? default=12.5")).toMatchObject(
      {
        dataType: "decimal(10,2)",
        default: { kind: "literal", value: 12.5 },
        kind: "decimal",
        nullable: true,
      }
    );
  });

  test("rejects invalid owner access", () => {
    expect(() =>
      parseSchema(
        `_version: "1.0.0"\nthings:\n  id: id\n  _access:\n    update: owner\n`
      )
    ).toThrow("requires owner_column");
  });

  test("requires underscored metadata", () => {
    expect(() => parseSchema(`version: "1.0.0"\nthings:\n  id: id\n`)).toThrow(
      "_version"
    );
  });

  test("reports YAML source locations for schema errors", () => {
    expect(() =>
      parseSchema(
        `_version: "1.0.0"\nentries:\n  id: id\n  author_id: references=missing.id\n`,
        {
          sourceName: "cms-schema.yaml",
        }
      )
    ).toThrow("cms-schema.yaml:4:3");
  });

  test("expands the complete auth macro", () => {
    const schema = parseSchema(
      `_version: "1.0.0"\n_extends: [auth]\n_auth:\n  roles: [user, admin]\n  api_keys: true\nposts:\n  id: id\n  user_id: string references=user.id\n`
    );
    const { user } = schema.tables;
    expect(user).toBeDefined();
    if (!user) {
      throw new Error("expected user table");
    }
    expect(user.columns).toHaveProperty("banned");
    expect(user.columns.role).toMatchObject({
      enumValues: ["user", "admin"],
      multiple: true,
    });
    const { session } = schema.tables;
    expect(session).toBeDefined();
    if (!session) {
      throw new Error("expected session table");
    }
    expect(session.columns.userId).toMatchObject({
      index: true,
      references: { column: "id", onDelete: "cascade", table: "user" },
    });
    const { apikey } = schema.tables;
    expect(apikey).toBeDefined();
    if (!apikey) {
      throw new Error("expected apikey table");
    }
    expect(apikey.columns).toHaveProperty("rateLimitEnabled");
    expect(schema.tableOrder.indexOf("user")).toBeLessThan(
      schema.tableOrder.indexOf("posts")
    );
  });

  test("expands files and attachment pivots", () => {
    const schema = parseSchema(
      `_version: "1.0.0"\n_extends: [auth, files]\n_files:\n  attach_to: [posts]\nposts:\n  id: id(bigint)\n`
    );
    const { file } = schema.tables;
    expect(file).toBeDefined();
    if (!file) {
      throw new Error("expected file table");
    }
    const userIdColumn = file.columns.userId;
    expect(userIdColumn).toBeDefined();
    if (!userIdColumn) {
      throw new Error("expected userId column");
    }
    expect(userIdColumn.references).toMatchObject({
      onDelete: "set null",
      table: "user",
    });
    const postsFile = schema.tables.posts_file;
    expect(postsFile).toBeDefined();
    if (!postsFile) {
      throw new Error("expected posts_file table");
    }
    expect(postsFile.columns.entityId).toMatchObject({
      dataType: "bigint",
      index: true,
      references: { column: "id", onDelete: "cascade", table: "posts" },
    });
    expect(postsFile.relations).toHaveProperty("file");
  });

  test("supports ownerless files without auth", () => {
    const schema = parseSchema(
      `_version: "1.0.0"\n_extends: [files]\n_files:\n  owner: false\nassets:\n  id: id\n`
    );
    const { file } = schema.tables;
    expect(file).toBeDefined();
    if (!file) {
      throw new Error("expected file table");
    }
    expect(file.columns.userId).toBeUndefined();
  });

  test("expands the idempotency macro", () => {
    const schema = parseSchema(
      `_version: "1.0.0"\n_extends: [idempotency]\ntasks:\n  id: id\n`
    );
    const table = schema.tables.paranorm_idempotency;
    expect(table).toBeDefined();
    if (!table) {
      throw new Error("expected paranorm_idempotency table");
    }
    expect(table.columns.key).toBeDefined();
    expect(table.columns.created_at ?? table.columns.createdAt).toBeDefined();
  });
});

describe("schema migrations", () => {
  test("diffs consecutive schemas", () => {
    const diff = diffSchemas(parseSchema(v1), parseSchema(v2));
    expect(
      diff.addedColumns.map(({ table, column }) => `${table}.${column.name}`)
    ).toEqual(["entries.title"]);
    expect(diff.removedColumns).toHaveLength(0);
  });

  test("exposes one migration per schema version", () => {
    const provider = new SchemaMigrationProvider({
      schemas: [{ content: v1 }, { content: v2, name: "002_v2" }],
    });
    const migrations = provider.getMigrations();
    expect(Object.keys(migrations)).toEqual(["1.0.0", "002_v2"]);
    const v2Migration = migrations["002_v2"];
    expect(v2Migration).toBeDefined();
    if (!v2Migration) {
      throw new Error("expected 002_v2 migration");
    }
    expect(v2Migration.id).toBe(2);
  });

  test("renders sqlite migration SQL", () => {
    const authored = defineSchema(
      `_version: "1.0.0"\nrecords:\n  id: id(bigint)\n  payload: json\n  bytes: binary\n`
    );
    const sqliteSql = createMigrator([authored], { dialect: "sqlite" }).sql();
    const [firstMigration] = sqliteSql;
    expect(firstMigration).toBeDefined();
    if (!firstMigration) {
      throw new Error("expected migration SQL");
    }
    const [firstStatement] = firstMigration.statements;
    expect(firstStatement).toBeDefined();
    if (!firstStatement) {
      throw new Error("expected first statement");
    }
    const sqliteStatement = firstStatement.sql;
    expect(sqliteStatement).toContain('"id" integer');
    expect(sqliteStatement).toContain('"payload" json');
    expect(sqliteStatement).toContain('"bytes" blob');
  });

  test("creates Effect migrator with schema sugar", async () => {
    const first = defineSchema(
      `_version: "1.0.0"\npeople:\n  id: id(varchar(64))\n  name: string\n`
    );
    const second = defineSchema(
      `_version: "2.0.0"\npeople:\n  id: id(varchar(64))\n  name: string\n  email: string? index\n`
    );
    const migrator = createMigrator([first, second], {
      table: "paranorm_migration",
    });

    const plan = migrator.plan();
    expect(plan).toHaveLength(2);
    expect(plan[1]).toMatchObject({
      destructive: false,
      name: "2.0.0",
      operations: [{ column: "email", kind: "addColumn", table: "people" }],
    });
    expect(migrator.validate()).toEqual(plan);
    const preview = migrator.sql();
    expect(
      preview.flatMap((migration) =>
        migration.statements.map((statement) => statement.sql)
      )
    ).toContain('ALTER TABLE "people" ADD COLUMN "email" varchar(255)');

    await Effect.runPromise(
      Effect.gen(function* migrate() {
        const applied = yield* migrator.migrate;
        expect(applied).toEqual([
          [1, "1.0.0"],
          [2, "2.0.0"],
        ]);
        expect(migrator.plan()).toHaveLength(2);

        const sql = yield* SqliteClient.SqliteClient;
        const columns = yield* sql<{
          name: string;
        }>`pragma table_info('people')`;
        expect(columns.map((column) => column.name)).toEqual([
          "id",
          "name",
          "email",
        ]);

        const again = yield* migrator.migrate;
        expect(again).toEqual([]);
      }).pipe(
        Effect.provide(
          SqliteClient.layer({ disableWAL: true, filename: ":memory:" })
        ),
        Effect.scoped
      )
    );
  });

  test("diffs removals, indexes, uniques, and destructive flags", () => {
    const from = parseSchema(`
_version: "1.0.0"
posts:
  id: id
  slug: string unique
  title: string index
  body: string
tags:
  id: id
`);
    const to = parseSchema(`
_version: "2.0.0"
posts:
  id: id
  slug: string
  title: string
  summary: string unique
`);
    const diff = diffSchemas(from, to);
    expect(diff.removedTables.map((table) => table.name)).toEqual(["tags"]);
    expect(
      diff.removedColumns.map(({ table, column }) => `${table}.${column.name}`)
    ).toEqual(["posts.body"]);
    expect(diff.removedIndexes).toContainEqual({
      column: "title",
      table: "posts",
    });
    expect(diff.removedUniqueConstraints).toContainEqual({
      columns: ["slug"],
      table: "posts",
    });
    expect(diff.addedUniqueConstraints).toContainEqual({
      columns: ["summary"],
      table: "posts",
    });
    expect(isDestructiveDiff(diff)).toBe(true);
    const slug = from.tables.posts?.columns.slug;
    const nextSlug = to.tables.posts?.columns.slug;
    expect(slug && nextSlug && columnChanged(slug, nextSlug)).toBe(true);
  });

  test("blocks destructive migrations unless allowed", () => {
    const first = `_version: "1.0.0"\nitems:\n  id: id\n  name: string\n`;
    const second = `_version: "2.0.0"\nitems:\n  id: id\n`;
    const migrator = createMigrator([first, second]);
    expect(() => migrator.validate()).toThrow("allowDestructive");
    expect(migrator.plan()[1]?.destructive).toBe(true);

    const allowed = createMigrator([first, second], {
      allowDestructive: true,
    });
    expect(allowed.validate()).toHaveLength(2);
    expect(
      allowed
        .sql()
        .flatMap((migration) =>
          migration.statements.map((statement) => statement.sql)
        )
    ).toContain('ALTER TABLE "items" DROP COLUMN "name"');
  });

  test("rejects unsupported sqlite column changes when compiling SQL", () => {
    const typeChange = createMigrator([
      `_version: "1.0.0"\nitems:\n  id: id\n  score: int\n`,
      `_version: "2.0.0"\nitems:\n  id: id\n  score: string\n`,
    ]);
    expect(typeChange.plan()).toHaveLength(2);
    expect(typeChange.plan()[1]?.operations).toContainEqual({
      column: "score",
      destructive: true,
      kind: "changeColumn",
      table: "items",
    });
    expect(() => typeChange.sql()).toThrow("Changing column type");

    const nullability = createMigrator([
      `_version: "1.0.0"\nitems:\n  id: id\n  name: string\n`,
      `_version: "2.0.0"\nitems:\n  id: id\n  name: string?\n`,
    ]);
    expect(nullability.plan()).toHaveLength(2);
    expect(() => nullability.sql()).toThrow("Changing nullability");

    const defaults = createMigrator([
      `_version: "1.0.0"\nitems:\n  id: id\n  name: string\n`,
      `_version: "2.0.0"\nitems:\n  id: id\n  name: string default="x"\n`,
    ]);
    expect(defaults.plan()).toHaveLength(2);
    expect(() => defaults.sql()).toThrow("Changing defaults");
  });

  test("rejects empty or non-ascending schema lists", () => {
    expect(() => new SchemaMigrationProvider({ schemas: [] })).toThrow(
      "at least one schema"
    );
    expect(
      () =>
        new SchemaMigrationProvider({
          schemas: [
            { content: `_version: "2.0.0"\na:\n  id: id\n` },
            { content: `_version: "1.0.0"\na:\n  id: id\n` },
          ],
        })
    ).toThrow("ascending version order");
  });

  test("normalizes migrator inputs and renders FK create SQL", () => {
    const authored = defineSchema(`
_version: "1.0.0"
parents:
  id: id
children:
  id: id
  parent_id: string references=parents.id on_delete=cascade index
`);
    const migrator = createMigrator(
      [{ source: authored.source, version: "1.0.0" }],
      { cuidDefaultSql: "'cuid'" }
    );
    const [preview] = migrator.sql();
    expect(preview?.name).toBe("1.0.0");
    const sqlText =
      preview?.statements.map((statement) => statement.sql).join("\n") ?? "";
    expect(sqlText).toContain("FOREIGN KEY");
    expect(sqlText).toContain("ON DELETE CASCADE");
    expect(sqlText).toContain("CREATE INDEX");
    expect(sqlText).toContain("DEFAULT ('cuid')");
  });

  test("applySchemaDiff and migrateSchemasToLatest enforce policy", async () => {
    const from = parseSchema(
      `_version: "1.0.0"\nitems:\n  id: id\n  name: string\n`
    );
    const to = parseSchema(`_version: "2.0.0"\nitems:\n  id: id\n`);
    const diff = diffSchemas(from, to);

    await expect(
      Effect.runPromise(
        applySchemaDiff(diff).pipe(
          Effect.provide(
            SqliteClient.layer({ disableWAL: true, filename: ":memory:" })
          ),
          Effect.scoped
        )
      )
    ).rejects.toThrow("allowDestructive");

    await Effect.runPromise(
      Effect.gen(function* applyAllowed() {
        const sql = yield* SqliteClient.SqliteClient;
        yield* sql`CREATE TABLE items (id text primary key, name text not null)`;
        yield* applySchemaDiff(diff, {
          allowDestructive: true,
        });
        const columns = yield* sql<{
          name: string;
        }>`pragma table_info('items')`;
        expect(columns.map((column) => column.name)).toEqual(["id"]);
      }).pipe(
        Effect.provide(
          SqliteClient.layer({ disableWAL: true, filename: ":memory:" })
        ),
        Effect.scoped
      )
    );

    await Effect.runPromise(
      Effect.gen(function* migrateLatest() {
        const applied = yield* migrateSchemasToLatest({
          schemas: [
            {
              content: `_version: "1.0.0"\nnotes:\n  id: id\n  body: string\n`,
            },
          ],
        });
        expect(applied).toEqual([[1, "1.0.0"]]);
        const sql = yield* SqliteClient.SqliteClient;
        const tables = yield* sql<{ name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'
        `;
        expect(tables).toHaveLength(1);
      }).pipe(
        Effect.provide(
          SqliteClient.layer({ disableWAL: true, filename: ":memory:" })
        ),
        Effect.scoped
      )
    );
  });
});
