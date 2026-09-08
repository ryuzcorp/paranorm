# ParanORM

Effect SQL on steroids: author database schemas in YAML, infer typed database interfaces, apply schema-diff migrations, and query through a compact model API.

ParanORM talks only to Effect's generic [`SqlClient`](https://effect.website/docs/v4/api/sql). Bring any driver from the [Effect SQL section](https://effect.website/docs/v4/api) (`@effect/sql-pg`, `@effect/sql-d1`, `@effect/sql-sqlite-node`, …).

## Install

```bash
npm i paranorm effect

# plus one driver, for example:
npm i @effect/sql-sqlite-node
# npm i @effect/sql-d1
# npm i @effect/sql-pg
```

## Quick start

Keep the YAML as a literal so TypeScript can infer its database type. Provide any `SqlClient` layer at the edge:

```ts
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { paranorm, defineSchema, type InferSchema } from "paranorm";

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
  program.pipe(
    Effect.provide(SqliteClient.layer({ filename: "app.db" })),
    Effect.scoped
  )
);
```

Cloudflare D1 / celld:

```ts
import { D1Client } from "@effect/sql-d1";

program.pipe(Effect.provide(D1Client.layer({ db: env.DB })), Effect.scoped);
```

Postgres:

```ts
import { PgClient } from "@effect/sql-pg";

program.pipe(
  Effect.provide(PgClient.layer({ database: "app" })),
  Effect.scoped
);
```

`paranorm<DB>()` creates models lazily through a proxy. Methods return Effects that require `SqlClient` from `effect/unstable/sql` — never a concrete driver type.

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

Writes use ParanORM's `Insertable` and `Updateable` helpers. Single-row writes return the affected row; `updateMany` and `deleteMany` return affected counts.

`upsert` uses `ON CONFLICT` (SQLite, Postgres, D1, …). Mutations that need a returned row use `RETURNING` / `OUTPUT` via Effect's dialect helpers.

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
- Generated file and attachment tables

For Better Auth table shapes, see [DOCS.md](./DOCS.md) — put auth and app tables in one `defineSchema`, then `InferSchema` / `createMigrator` on that value.

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

The tag dedents leading blank lines and the indent of the first remaining line (same rules as `defineSchema`). Interpolations are rejected. TypeScript does not expose tagged-template text as a string-literal type, so use `defineSchema(yamlLiteral)` when compile-time inference is needed.

See [SPEC.md](./SPEC.md) for the complete authoring format and [DOCS.md](./DOCS.md) for recipes (including Better Auth).

## Schema migrations

`createMigrator` builds a forward-only schema-diff migrator over Effect `SqlClient`:

```ts
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { createMigrator, defineSchema } from "paranorm";

const v1 = defineSchema(`_version: "1.0.0"\nusers:\n  id: id\n`);
const v2 = defineSchema(
  `_version: "2.0.0"\nusers:\n  id: id\n  email: string?\n`
);

const migrator = createMigrator([v1, v2], {
  allowDestructive: false,
  table: "paranorm_migrations",
});

migrator.plan();
migrator.validate();
migrator.sql();

await Effect.runPromise(
  migrator.migrate.pipe(
    Effect.provide(SqliteClient.layer({ filename: "app.db" })),
    Effect.scoped
  )
);
```

Or wire migrations into a layer:

```ts
const SqlLive = Layer.provideMerge(
  migrator.layer,
  SqliteClient.layer({ filename: "app.db" })
);
```

`SchemaMigrationProvider` and `migrateSchemasToLatest` remain available as lower-level APIs. Forward destructive changes require `allowDestructive: true`. Unsupported SQLite column rewrites fail at `sql()` / `migrate`, not when constructing the migrator.

Migration DDL currently renders SQLite SQL (`dialect: "sqlite"`). Pair it with SQLite-compatible drivers (D1, `sql-sqlite-node`, Bun, wasm, …). Query APIs remain driver-agnostic regardless.

## Write notify and idempotency

```ts
import { afterWrite, once, defineSchema } from "paranorm";

const schema = defineSchema(`
  _version: "1.0.0"
  _extends: [idempotency]
  posts:
    id: id
    title: string
`);

yield *
  orm.posts
    .create({ data: { title: "hi" } })
    .pipe(afterWrite((row) => publish(row)));

yield *
  once("create-post-1", () => orm.posts.create({ data: { title: "hi" } }));
```

`afterWrite` taps successful values only. `once` claims a key with insert-or-ignore; duplicates return `null` unless `ignoreDuplicate: false` (then `IdempotencyConflictError`).
