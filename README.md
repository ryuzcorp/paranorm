# Kysola

Kysely on steroids: author database schemas in YAML, infer Kysely types, apply schema-diff
migrations, and query through a compact model API.

## Install

```bash
npm i kysola kysely
```

## Quick start

Keep the YAML as a literal so TypeScript can infer its database type:

```ts
import { Kysely } from "kysely";
import { createKysola, defineSchema, type InferSchema } from "kysola";

const schema = defineSchema(
  `
_version: "1.0.0"
users:
  id: id(bigint)
  email: string unique
  name: string
  created_at: timestamp default=now
posts:
  id: id(bigint)
  user_id: references=users.id on_delete=cascade index
  title: string
  status: string enum=[draft,published] default="draft"
  published_at: timestamp?
` as const,
);

type DB = InferSchema<typeof schema>;

const db = new Kysely<DB>({ dialect });
const kysola = createKysola(db);

const posts = await kysola.posts.findMany({
  where: {
    status: "published",
    OR: [{ title: { contains: "Kysely" } }, { title: { startsWith: "SQL" } }],
  },
  select: { id: true, title: true },
  orderBy: [{ published_at: "desc" }],
  take: 20,
});
```

`createKysola` accepts only `Kysely<DB>`. Models are created lazily through a proxy, while
table names, columns, rows, filters, and operators are inferred from the Kysely database
type. No table list, schema object, or relation metadata is passed to the query wrapper.

## Query API

Every inferred table exposes:

```ts
kysola.users.findMany(args?)
kysola.users.findFirst(args?)
kysola.users.findUnique({ where })
kysola.users.create({ data })
kysola.users.createMany({ data })
kysola.users.update({ where, data })
kysola.users.updateMany({ where, data })
kysola.users.delete({ where })
kysola.users.deleteMany({ where })
kysola.users.upsert({ where, create, update })
kysola.users.count({ where }?)
kysola.users.exists({ where }?)
kysola.users.paginate(args)
```

Selections return projected types instead of the full row:

```ts
const users = await kysola.users.findMany({
  select: { id: true, email: true },
});
// Array<{ id: string; email: string }>
```

Writes use Kysely's inferred `Insertable` and `Updateable` types. Single-row writes return
the affected row; `updateMany` and `deleteMany` return affected counts.

### Filters

Fields accept direct equality values or type-specific operators:

```ts
await kysola.users.findMany({
  where: {
    email: { endsWith: "@example.com" },
    name: { notIn: ["Bot", "Deleted"] },
    OR: [{ name: { startsWith: "A" } }, { name: { startsWith: "B" } }],
    NOT: { email: { contains: "+blocked" } },
  },
});
```

Supported operators:

- Strings: `equals`, `not`, `in`, `notIn`, `contains`, `startsWith`, `endsWith`
- Numbers: `equals`, `not`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte`
- Dates: `equals`, `not`, `lt`, `lte`, `gt`, `gte`
- Booleans: `equals`, `not`
- Nullable fields: `isNull`
- Logical composition: `AND`, `OR`, `NOT`

LIKE wildcards in user values are escaped automatically.

### Pagination

Offset pagination:

```ts
const page = await kysola.posts.paginate({
  orderBy: [{ id: "asc" }],
  take: 20,
  skip: 40,
});
```

Cursor pagination:

```ts
const first = await kysola.posts.paginate({
  orderBy: [{ published_at: "desc" }, { id: "asc" }],
  take: 20,
});

const next = await kysola.posts.paginate({
  orderBy: [{ published_at: "desc" }, { id: "asc" }],
  take: 20,
  after: first.pagination.endCursor!,
});
```

The result includes `count`, `hasNext`, `hasPrevious`, `startCursor`, and `endCursor`.

## YAML type inference

Use either API:

```ts
import { defineSchema, type InferDatabase, type InferSchema } from "kysola";

const schema = defineSchema(yamlLiteral);
type DB = InferSchema<typeof schema>;

// Equivalent:
type DBDirect = InferDatabase<typeof yamlLiteral>;
```

Inference supports:

- Generated IDs and columns with defaults
- Nullable insert/select types
- Foreign-key column types
- String enum unions
- `string`, integer, bigint, decimal, boolean, date, timestamp, JSON, and binary columns
- Generated auth, API-key, file, and attachment tables
- Kysely's `Selectable`, `Insertable`, and `Updateable` helpers

### Tagged YAML templates

For IDE extensions that highlight tagged templates, use the exported `schema` tag directly
or alias it to `yaml`:

```ts
import { schema as yaml } from "kysola";

function loadSchema() {
  return yaml`
    _version: "1.0.0"
    users:
      id: id(bigint)
      email: string unique
  `;
}
```

The tag uses [`dedent`](https://github.com/dmnd/dedent), so surrounding code indentation is
removed automatically. Interpolations are rejected so the template always contains one complete schema document.
TypeScript does not expose tagged-template contents as a string-literal type, so use
`defineSchema(yamlLiteral as const)` when `InferSchema` compile-time inference is needed.

TypeScript can only infer a string known at compile time. A schema loaded with
`Bun.file(...).text()` is a runtime `string` and requires generated declarations instead.
Runtime parsing remains the authoritative schema validator.

See [SPEC.md](./SPEC.md) for the complete authoring format.

## Schema migrations

`createMigrator` wraps Kysely's native `Migrator` and derives migration names from each
schema's `_version`:

```ts
import { createMigrator, defineSchema } from "kysola";

const v1 = defineSchema(`_version: "1.0.0"\nusers:\n  id: id\n` as const);
const v2 = defineSchema(`_version: "2.0.0"\nusers:\n  id: id\n  email: string?\n` as const);

const migrator = createMigrator(db, [v1, v2]);

await migrator.plan(); // Pending structured operations
await migrator.validate(); // Ordering and destructive-policy validation
await migrator.sql(); // Compiled SQL without execution
await migrator.migrateToLatest();
await migrator.migrateUp();
await migrator.migrateDown();
await migrator.migrateTo("1.0.0");
```

It returns Kysely's actual `Migrator`, preserving its methods, locking, migration tables,
and result/error behavior. Inputs may be typed schemas, YAML strings, or `{ name, content
}` sources. A third argument accepts both schema options and Kysely migrator options:

```ts
const migrator = createMigrator(db, [v1, v2], {
  dialect: "postgres",
  allowDestructive: false,
  allowUnorderedMigrations: false,
  migrationTableName: "kysola_migration",
  migrationLockTableName: "kysola_migration_lock",
});
```

`SchemaMigrationProvider` and `migrateSchemasToLatest` remain available as lower-level and
compatibility APIs. Forward destructive changes require `allowDestructive: true`.
Migration rendering supports `postgres`, `sqlite`, `mysql`, and `mssql` type/default
variants. Dialect-specific `ALTER TABLE`, mutation `RETURNING`, and upsert limitations
still apply.

Schema errors include source locations when parsing strings. Named migration sources are
reported as `name:line:column`.

## Compatibility

`createSola` and the `Sola` type are aliases retained for users of the original API.
