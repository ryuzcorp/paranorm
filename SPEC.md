# ParanORM Specification

## 1. Purpose

ParanORM is a Kysely-focused toolkit with three connected surfaces:

1. A YAML authoring format for immutable database schema versions.
2. A typed model API created directly from `Kysely<DB>`.
3. A schema-diff `MigrationProvider` and sugar around Kysely's native `Migrator`.

ParanORM is not a replacement for Kysely. The Kysely database type remains authoritative,
raw Kysely queries remain available, and ParanORM's migrator preserves Kysely's locking,
history tables, methods, and result types.

## 2. Canonical usage

```ts
import { Kysely } from "kysely";
import { createParanORM, createMigrator, defineSchema, type InferSchema } from "paranorm";

const schemaV1 = defineSchema(`
  _version: "1.0.0"
  users:
    id: id(bigint)
    email: string unique
    name: string
`);

type DB = InferSchema<typeof schemaV1>;

const db = new Kysely<DB>({ dialect });
const paranorm = createParanORM(db);
const migrator = createMigrator(db, [schemaV1], { dialect: "postgres" });
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

Required semver string. Published schema versions are immutable. Structural changes must
be represented by a new document with a greater version.

### 3.2 `_extends`

Optional macro list. Macros expand before user tables are validated.

- `auth` creates Better Auth core/admin tables and optional API-key tables.
- `files` creates file metadata and attachment pivot tables.

### 3.3 Tables

A table is a top-level mapping whose key does not start with `_`. Its key is both its
TypeScript-facing and database table name.

Reserved table blocks are `_relations` and `_access`. Every other key is a column.

## 4. Columns

A column is a string containing one base type followed by modifiers:

```text
<type>[?] [modifier] [modifier] ...
```

### 4.1 Base types

| Type             | Kysely value                                   |
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

| Modifier                   | Meaning                                           |
| -------------------------- | ------------------------------------------------- |
| `unique`                   | Single-column unique constraint                   |
| `unique=[table.a,table.b]` | Composite unique constraint                       |
| `index`                    | Non-unique index                                  |
| `default=<literal>`        | Literal or keyword default                        |
| `default=now`              | Current timestamp default                         |
| `default=sql("...")`       | Raw SQL default expression                        |
| `references=table.column`  | Foreign key with inferred local SQL/value type    |
| `on_delete=<action>`       | `cascade`, `set_null`, `restrict`, or `no_action` |
| `on_update=<action>`       | Same actions as `on_delete`                       |
| `enum=[a,b]`               | Text value union in inferred types                |
| `multiple`                 | Comma-separated enum set, used by auth roles      |

Foreign-key actions must follow `references=` in the same definition.

## 5. Built-in macros

### 5.1 Auth

```yaml
_extends: [auth]
_auth:
  roles: [user, admin, support]
  api_keys: true
```

The macro creates `user`, `session`, `account`, and `verification`, including Better Auth
admin fields. `api_keys: true` also creates `apikey`. Auth foreign keys use indexes and
cascade behavior where required.

### 5.2 Files

```yaml
_extends: [auth, files]
_files:
  attach_to: [posts]
  owner: true
```

The macro creates `file` and one `<table>_file` pivot for every attachment target. Pivot
`entityId` uses the attached table's ID type. Owned files require the auth macro;
`owner: false` removes `file.userId`.

## 6. Relations and access metadata

Supported relations are:

```yaml
_relation_name: belongs_to=target
_relation_name: has_many=target
```

`belongs_to` requires exactly one foreign key to the target. `has_many` requires a reverse
`belongs_to`. Ambiguous multiple foreign keys to one target are rejected.

Access policies support `public`, `authenticated`, and `owner` for `list`, `create`,
`update`, and `delete`. Owner policies require an existing `owner_column`.

These blocks are schema metadata. The current DB-only `createParanORM(db)` model API does
not load relation or access metadata at runtime.

## 7. Type inference

```ts
const authored = defineSchema(yamlLiteral);
type DB = InferSchema<typeof authored>;

// Equivalent when the literal source itself is available:
type DB2 = InferDatabase<typeof yamlLiteral>;
```

Inference covers tables, columns, references, defaults, generated IDs, nullability,
enums, auth, files, and Kysely's `Selectable`, `Insertable`, and `Updateable` behavior.

The `schema` tagged template is a dedented runtime authoring helper and may be aliased to
`yaml`. TypeScript does not expose tagged-template static segments as literal tuple types,
so `InferSchema` inference requires `defineSchema(...)` with a literal or `const` string.

## 8. Query model API

```ts
const paranorm = createParanORM(db);
```

`createParanORM` accepts only `Kysely<DB>`. A lazy proxy creates one model per accessed table.

Each model provides:

- `findMany`, `findFirst`, `findUnique`
- `create`, `createMany`
- `update`, `updateMany`
- `delete`, `deleteMany`
- `upsert`
- `count`, `exists`, `paginate`

Selections produce projected result types:

```ts
const rows = await paranorm.users.findMany({
  select: { id: true, email: true },
});
// Array<{ id: string; email: string }>
```

Writes use Kysely's `Insertable<Table>` and `Updateable<Table>` types. Single-row writes
return the affected row or throw `ParanORMError("NOT_FOUND")`. Mutation returning and upsert
support remain subject to the configured SQL dialect.

Filters support direct equality, `AND`/`OR`/`NOT`, string matching, comparisons, sets, and
null checks. LIKE wildcard input is escaped. Pagination supports offset and multi-column
keyset cursors.

## 9. Migrations

```ts
const migrator = createMigrator(db, [schemaV1, schemaV2], {
  dialect: "postgres",
  allowDestructive: false,
});

await migrator.plan();
await migrator.validate();
await migrator.sql();
await migrator.migrateToLatest();
await migrator.migrateDown();
```

`createMigrator` returns Kysely's `Migrator` enhanced with:

- `plan()` — pending schema operations with destructive flags.
- `validate()` — validates pending history and destructive-change policy.
- `sql()` — dialect-compiled SQL and parameters without applying migrations.

Inputs may be typed schemas, YAML strings, or `{ name, content }`. Names default to
`_version`. Low-level `SchemaMigrationProvider` and `applySchemaDiff` remain public.

Supported migration dialect options are `postgres`, `sqlite`, `mysql`, and `mssql`.
Dialect rendering currently covers JSON, binary, UUID, auto-increment IDs, UUID defaults,
and portable current-timestamp defaults. Dialect-specific `ALTER TABLE`, `RETURNING`, and
upsert limitations still apply.

## 10. Diagnostics

String schema validation throws `SchemaValidationError` with `sourceName`, line, and
column:

```text
cms-schema.yaml:18:3 Invalid schema: entries.author_id references missing column 'users.id'
```

Migration source names are forwarded into diagnostics. Object-form schemas cannot provide
source locations unless the caller retains and supplies their text.

## 11. Dependency ordering and safety

Tables are created in foreign-key dependency order and removed in reverse order. Cyclic
foreign keys are rejected. Indexes and constraints are removed before destructive column
operations. Forward destructive migrations require `allowDestructive: true`; down
migrations enable destructive reversal automatically.

## 12. Next additions (5–10)

### 5. Complete dialect hardening

Add dialect capability checks, native integration suites for PostgreSQL/MySQL/MSSQL, safe
SQLite table-rebuild migrations, and explicit errors for unsupported `RETURNING`, upsert,
constraint, and alter-column operations.

### 6. Aggregates and grouping

Add typed `aggregate` and `groupBy` APIs for count, sum, average, minimum, and maximum,
including projected aggregate result types.

### 7. Reusable query fragments

Allow typed reusable `where`, selection, and ordering fragments that can be shared by
`findMany`, `count`, `exists`, and pagination without losing inference.

### 8. Transaction ergonomics

Document and test `createParanORM(trx)` with Kysely transactions, and add an optional helper
that scopes a ParanORM instance to a transaction callback.

### 9. CLI tooling

Add `paranorm schema check`, `schema format`, `schema diff`, `migrate status`, `migrate sql`,
and `migrate latest` commands with machine-readable output.

### 10. Generated declarations and YAML imports

Add code generation and Vite/editor integration so real `.yaml` files can be imported with
exact `InferSchema` types, diagnostics, and highlighting without duplicating schema text in
TypeScript.
