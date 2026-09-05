# ParanORM

Effect SQL on steroids: author database schemas in YAML, infer typed database
interfaces, apply schema-diff migrations, and query through a compact model API.

## Install

```bash
npm i paranorm effect

# Cloudflare Workers / celld (D1)
npm i @effect/sql-d1

# Node Fetch / standard Node (node:sqlite, Node 22.16+)
npm i @effect/sql-sqlite-node
```

## Quick start

Keep the YAML as a literal so TypeScript can infer its database type. Choose a
dialect layer for your runtime, then query through Effects:

```ts
import { Effect } from "effect";
import { paranorm, defineSchema, type InferSchema } from "paranorm";
import { SqliteClient } from "paranorm/sqlite-node";
// Cloudflare / celld:
// import { D1Client } from "paranorm/d1";

const schema = defineSchema(`
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
`);

type DB = InferSchema<typeof schema>;
const orm = paranorm<DB>();

const program = Effect.gen(function* () {
  return yield* orm.posts.findMany({
    where: {
      status: "published",
      OR: [{ title: { contains: "Effect" } }, { title: { startsWith: "SQL" } }],
    },
    select: { id: true, title: true },
    orderBy: [{ published_at: "desc" }],
    take: 20,
  });
});

const posts = await Effect.runPromise(
  program.pipe(Effect.provide(SqliteClient.layer({ filename: "app.db" })), Effect.scoped),
);
```

On Cloudflare Workers / celld, swap the layer:

```ts
program.pipe(Effect.provide(D1Client.layer({ db: env.DB })), Effect.scoped);
```

`paranorm<DB>()` creates models lazily through a proxy. Table names, columns,
rows, filters, and operators are inferred from `DB`. Methods return Effects that
require `SqlClient` from `effect/unstable/sql`.

## Dialects

| Runtime                    | Entry                  | Layer                              |
| -------------------------- | ---------------------- | ---------------------------------- |
| Cloudflare Workers / celld | `paranorm/d1`          | `D1Client.layer({ db })`           |
| Node Fetch / `node:sqlite` | `paranorm/sqlite-node` | `SqliteClient.layer({ filename })` |

Core code depends only on Effect's generic `SqlClient`. Pick the dialect at the
edge so Workers never pull in `node:sqlite`.

## Query API

Every inferred table exposes:

```ts
orm.users.findMany(args?)
orm.users.findFirst(args?)
orm.users.findUnique({ where })
orm.users.create({ data })
orm.users.createMany({ data })
orm.users.update({ where, data })
orm.users.updateMany({ where, data })
orm.users.delete({ where })
orm.users.deleteMany({ where })
orm.users.upsert({ where, create, update })
orm.users.count({ where }?)
orm.users.exists({ where }?)
orm.users.paginate(args)
```

Selections return projected types instead of the full row:

```ts
const users =
  yield *
  orm.users.findMany({
    select: { id: true, email: true },
  });
// Array<{ id: string; email: string }>
```

Writes use ParanORM's `Insertable` and `Updateable` helpers. Single-row writes
return the affected row; `updateMany` and `deleteMany` return affected counts.

### Filters

Fields accept direct equality values or type-specific operators:

```ts
yield *
  orm.users.findMany({
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
const page =
  yield *
  orm.posts.paginate({
    orderBy: [{ id: "asc" }],
    take: 20,
    skip: 40,
  });
```

Cursor pagination:

```ts
const first =
  yield *
  orm.posts.paginate({
    orderBy: [{ published_at: "desc" }, { id: "asc" }],
    take: 20,
  });

const next =
  yield *
  orm.posts.paginate({
    orderBy: [{ published_at: "desc" }, { id: "asc" }],
    take: 20,
    after: first.pagination.endCursor!,
  });
```

The result includes `count`, `hasNext`, `hasPrevious`, `startCursor`, and `endCursor`.

## YAML type inference

Use either API:

```ts
import { defineSchema, type InferDatabase, type InferSchema } from "paranorm";
import type { Insertable, Selectable, Updateable } from "paranorm";

const schema = defineSchema(yamlLiteral);
type DB = InferSchema<typeof schema>;

type User = Selectable<DB["users"]>;
type NewUser = Insertable<DB["users"]>;
type UserUpdate = Updateable<DB["users"]>;
```

Inference supports:

- Generated IDs and columns with defaults
- Nullable insert/select types
- Foreign-key column types
- String enum unions
- `string`, integer, bigint, decimal, boolean, date, timestamp, JSON, and binary columns
- Generated auth, API-key, file, and attachment tables

### Tagged YAML templates

```ts
import { schema as yaml } from "paranorm";

function loadSchema() {
  return yaml`
    _version: "1.0.0"
    users:
      id: id(bigint)
      email: string unique
  `;
}
```

The tag uses [`dedent`](https://github.com/dmnd/dedent). Interpolations are
rejected. TypeScript does not expose tagged-template text as a string-literal
type, so use `defineSchema(yamlLiteral)` when compile-time inference is needed.

See [SPEC.md](./SPEC.md) for the complete authoring format.

## Schema migrations

`createMigrator` builds a forward-only schema-diff migrator over Effect
`SqlClient` (works on both D1 and Node SQLite):

```ts
import { Effect } from "effect";
import { createMigrator, defineSchema } from "paranorm";
import { SqliteClient } from "paranorm/sqlite-node";

const v1 = defineSchema(`_version: "1.0.0"\nusers:\n  id: id\n`);
const v2 = defineSchema(`_version: "2.0.0"\nusers:\n  id: id\n  email: string?\n`);

const migrator = createMigrator([v1, v2], {
  table: "paranorm_migrations",
  allowDestructive: false,
});

migrator.plan(); // Structured operations
migrator.validate(); // Destructive-policy validation
migrator.sql(); // Compiled SQL without execution

await Effect.runPromise(
  migrator.migrate.pipe(Effect.provide(SqliteClient.layer({ filename: "app.db" })), Effect.scoped),
);
```

Or wire migrations into a layer:

```ts
const SqlLive = Layer.provideMerge(migrator.layer, SqliteClient.layer({ filename: "app.db" }));
```

`SchemaMigrationProvider` and `migrateSchemasToLatest` remain available as
lower-level APIs. Forward destructive changes require `allowDestructive: true`.
DDL rendering targets SQLite (both runtime dialects).
