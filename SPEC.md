# ParanORM Specification

## 1. Purpose

ParanORM is an Effect SQL toolkit with three connected surfaces:

1. A YAML authoring format for immutable database schema versions.
2. A typed model API over Effect `SqlClient` (any `@effect/sql-*` driver).
3. A forward-only schema-diff migrator that emits SQL as Effects.

ParanORM is not a SQL driver. Consumers provide any layer that implements `SqlClient` from `effect/unstable/sql`.

## 2. Canonical usage

```ts
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  paranorm,
  createMigrator,
  defineSchema,
  type InferSchema,
} from "paranorm";

const schemaV1 = defineSchema(`
  _version: "1.0.0"
  users:
    id: id(bigint)
    email: string unique
    name: string
`);

type DB = InferSchema<typeof schemaV1>;

const orm = paranorm<DB>();
const migrator = createMigrator([schemaV1]);

const program = Effect.gen(function* () {
  yield* migrator.migrate;
  return yield* orm.users.findMany();
}).pipe(
  Effect.provide(SqliteClient.layer({ filename: "app.db" })),
  Effect.scoped
);
```

`defineSchema` removes common indentation at runtime and at the type level.

## 3. YAML document format

All document metadata starts with `_`. Every top-level key without `_` is a table.

```yaml
_version: "1.0.0"
_extends: [auth, files]

_auth:
  roles: [user, admin]
  api_keys: true

_files:
  attach_to: [posts]
  owner: true

posts:
  id: id(bigint)
  user_id: references=user.id on_delete=cascade index
  title: string
  status: string enum=[draft,published] default="draft"
  published_at: timestamp?
  _relations:
    user: belongs_to=user
  _access:
    list: public
    create: authenticated
    update: owner
    owner_column: user_id
```

### 3.1 `_version`

Required semver string. Published schema versions are immutable. Structural changes must be represented by a new document with a greater version.

### 3.2 `_extends`

Optional macro list. Macros expand before user tables are validated.

- `auth` creates Better Auth core/admin tables and optional API-key tables.
- `files` creates file metadata and attachment pivot tables.

### 3.3 Tables

A table is a top-level mapping whose key does not start with `_`. Its key is both its TypeScript-facing and database table name.

Reserved table blocks are `_relations` and `_access`. Every other key is a column.

## 4. Columns

A column is a string containing one base type followed by modifiers:

```text
<type>[?] [modifier] [modifier] ...
```

### 4.1 Base types

| Type             | Selected value                                 |
| ---------------- | ---------------------------------------------- |
| `id`             | Generated string primary key                   |
| `id(varchar(n))` | Generated string primary key with custom size  |
| `id(bigint)`     | Auto-increment primary key; selected as string |
| `id(uuidv4)`     | Generated UUID primary key                     |
| `string`         | `string`                                       |
| `int`            | `number`                                       |
| `bigint`         | `string`                                       |
| `decimal(p,s)`   | `string`                                       |
| `boolean`        | `boolean`                                      |
| `timestamp`      | `Date`                                         |
| `date`           | `Date`                                         |
| `json`           | `JSONValue`                                    |
| `binary`         | `Uint8Array`                                   |

A trailing `?` makes the selected value nullable and the insert value optional.

### 4.2 Modifiers

| Modifier | Meaning |
| --- | --- |
| `unique` | Single-column unique constraint |
| `unique=[table.a,table.b]` | Composite unique constraint |
| `index` | Non-unique index |
| `default=<literal>` | Literal or keyword default |
| `default=now` | Current timestamp default |
| `default=sql("...")` | Raw SQL default expression |
| `references=table.column` | Foreign key with inferred local SQL/value type |
| `on_delete=<action>` | `cascade`, `set_null`, `restrict`, or `no_action` |
| `on_update=<action>` | Same actions as `on_delete` |
| `enum=[a,b]` | Text value union in inferred types |
| `multiple` | Comma-separated enum set, used by auth roles |

Foreign-key actions must follow `references=` in the same definition.

## 5. Built-in macros

### 5.1 Auth

```yaml
_extends: [auth]
_auth:
  roles: [user, admin, support]
  api_keys: true
```

The macro creates `user`, `session`, `account`, and `verification`, including Better Auth admin fields. `api_keys: true` also creates `apikey`. Auth foreign keys use indexes and cascade behavior where required.

### 5.2 Files

```yaml
_extends: [auth, files]
_files:
  attach_to: [posts]
  owner: true
```

The macro creates `file` and one `<table>_file` pivot for every attachment target. Pivot `entityId` uses the attached table's ID type. Owned files require the auth macro; `owner: false` removes `file.userId`.

### 5.3 Idempotency

```yaml
_extends: [idempotency]
```

Creates `paranorm_idempotency` (`key` primary key + `created_at`) for use with `once()`.

## 6. Relations and access metadata

Supported relations are:

```yaml
_relation_name: belongs_to=target
_relation_name: has_many=target
```

`belongs_to` requires exactly one foreign key to the target. `has_many` requires a reverse `belongs_to`. Ambiguous multiple foreign keys to one target are rejected.

Access policies support `public`, `authenticated`, and `owner` for `list`, `create`, `update`, and `delete`. Owner policies require an existing `owner_column`.

These blocks are schema metadata. The current DB-only `paranorm(db)` model API does not load relation or access metadata at runtime.

## 7. Type inference

```ts
const authored = defineSchema(yamlLiteral);
type DB = InferSchema<typeof authored>;

// Equivalent when the literal source itself is available:
type DB2 = InferDatabase<typeof yamlLiteral>;
```

Inference covers tables, columns, references, defaults, generated IDs, nullability, enums, auth, files, and ParanORM's `Selectable`, `Insertable`, and `Updateable` helpers.

`defineSchema` / `schema` dedent by dropping leading blank lines, then stripping the indent of the first remaining line from lines that share that prefix. Top-level keys at column 0 do not strip nested column indentation.

The `schema` tagged template is a runtime authoring helper and may be aliased to `yaml`. TypeScript does not expose tagged-template static segments as literal tuple types, so `InferSchema` inference requires `defineSchema(...)` with a literal or `const` string.

## 8. Query model API

```ts
const orm = paranorm<DB>();
```

`paranorm` creates a lazy proxy of models. Each method returns an Effect requiring `SqlClient` from `effect/unstable/sql`.

Each model provides:

- `findMany`, `findFirst`, `findUnique`
- `create`, `createMany`
- `update`, `updateMany`
- `delete`, `deleteMany`
- `upsert`
- `count`, `exists`, `paginate`

Selections produce projected result types:

```ts
const rows =
  yield *
  orm.users.findMany({
    select: { id: true, email: true },
  });
// Array<{ id: string; email: string }>
```

Writes use ParanORM's `Insertable<Table>` and `Updateable<Table>` types. Single-row writes return the affected row or fail with `ParanOrmError("NOT_FOUND")`. Mutations use Effect dialect helpers (`RETURNING` / `OUTPUT`); `upsert` uses `ON CONFLICT`.

Filters support direct equality, `AND`/`OR`/`NOT`, string matching, comparisons, sets, and null checks. LIKE wildcard input is escaped. Pagination supports offset and multi-column keyset cursors.

## 9. Migrations

```ts
const migrator = createMigrator([schemaV1, schemaV2], {
  table: "paranorm_migrations",
  allowDestructive: false,
});

migrator.plan();
migrator.validate();
migrator.sql();
yield * migrator.migrate;
```

`createMigrator` returns:

- `plan()` — schema operations with destructive flags (no SQL compile).
- `validate()` — validates destructive-change policy.
- `sql()` — compiled SQL and parameters without applying migrations.
- `migrate` — Effect that applies pending migrations (no transaction wrapper, so D1 works).
- `layer` / `loader` — for composing with Effect layers and `Migrator.fromRecord`.

Inputs may be typed schemas, YAML strings, or `{ name, content }`. Names default to `_version`. Low-level `SchemaMigrationProvider` and `applySchemaDiff` remain public. Unsupported SQLite in-place alters fail when compiling SQL (`sql()` / `migrate`), not when constructing the migrator.

Migration DDL currently renders SQLite SQL. Pair with SQLite-compatible `SqlClient` drivers; the query API itself accepts any Effect SQL client.

## 10. Write notify and idempotency

```ts
import { afterWrite, once } from "paranorm";

yield * orm.posts.create({ data }).pipe(afterWrite(publishSnapshot));

yield * once("job-42", () => orm.posts.create({ data }));
```

- `afterWrite(tap)` — runs after a successful Effect value (skipped on failure).
- `once(key, fn)` — insert-or-ignore claim; duplicate keys return `null` by default or throw `IdempotencyConflictError` when `ignoreDuplicate: false`.
- Pair with `_extends: [idempotency]` (or an equivalent table) before using `once`.

## 11. Diagnostics

String schema validation throws `SchemaValidationError` with `sourceName`, line, and column:

```text
cms-schema.yaml:18:3 Invalid schema: entries.author_id references missing column 'users.id'
```

Migration source names are forwarded into diagnostics. Object-form schemas cannot provide source locations unless the caller retains and supplies their text.

## 12. Dependency ordering and safety

Tables are created in foreign-key dependency order and removed in reverse order. Cyclic foreign keys are rejected. Indexes and constraints are removed before destructive column operations. Forward destructive migrations require `allowDestructive: true`. Migrations are forward-only.

## 13. Next additions

### Dialect hardening

Add safe SQLite table-rebuild migrations for unsupported `ALTER` operations, and explicit errors for constraint/alter-column cases that SQLite cannot express in place.

### Aggregates and grouping

Add typed `aggregate` and `groupBy` APIs for count, sum, average, minimum, and maximum, including projected aggregate result types.

### Reusable query fragments

Allow typed reusable `where`, selection, and ordering fragments that can be shared by `findMany`, `count`, `exists`, and pagination without losing inference.

### Transaction ergonomics

Document and test `sql.withTransaction` with ParanORM Effects on Node SQLite, and note D1 batch semantics as the atomic alternative.

### CLI tooling

Add `paranorm schema check`, `schema format`, `schema diff`, `migrate status`, `migrate sql`, and `migrate latest` commands with machine-readable output.

### Generated declarations and YAML imports

Add code generation and Vite/editor integration so real `.yaml` files can be imported with exact `InferSchema` types, diagnostics, and highlighting without duplicating schema text in TypeScript.
