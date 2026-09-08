# ParanORM docs

## Recipe: Better Auth schema

ParanORM does not ship an auth macro. Author Better Auth tables in **one** `defineSchema` literal alongside your app tables, then `InferSchema` and `createMigrator([schema])` from that single value. Keep the YAML aligned with your Better Auth plugins.

Target shape below matches **better-auth@1.7.x** with the **admin** plugin fields on `user` / `session`. Add plugin tables (e.g. `passkey`) only when that plugin is enabled.

```ts
import { defineSchema, type InferSchema } from "paranorm";

export const schema = defineSchema(`
  _version: "1.0.0"
  _extends: [idempotency]

  user:
    id: id
    name: string
    email: string unique
    emailVerified: boolean default=false
    image: string?
    role: string default="user"
    banned: boolean default=false
    banReason: string?
    banExpires: timestamp?
    createdAt: timestamp default=now
    updatedAt: timestamp default=now
    _relations:
      accounts: has_many=account
      sessions: has_many=session

  session:
    id: id
    expiresAt: timestamp
    token: string unique
    createdAt: timestamp default=now
    updatedAt: timestamp default=now
    ipAddress: string?
    userAgent: string?
    userId: references=user.id on_delete=cascade index
    impersonatedBy: string?
    _relations:
      user: belongs_to=user

  account:
    id: id
    accountId: string
    providerId: string
    userId: references=user.id on_delete=cascade index
    accessToken: string?
    refreshToken: string?
    idToken: string?
    accessTokenExpiresAt: timestamp?
    refreshTokenExpiresAt: timestamp?
    scope: string?
    password: string?
    createdAt: timestamp default=now
    updatedAt: timestamp default=now
    _relations:
      user: belongs_to=user

  verification:
    id: id
    identifier: string index
    value: string
    expiresAt: timestamp
    createdAt: timestamp default=now
    updatedAt: timestamp default=now

  # @better-auth/passkey — omit if unused
  passkey:
    id: id
    name: string?
    publicKey: string
    userId: references=user.id on_delete=cascade index
    credentialID: string index
    counter: int
    deviceType: string
    backedUp: boolean
    transports: string?
    createdAt: timestamp? default=now
    aaguid: string?
    _relations:
      user: belongs_to=user

  tasks:
    id: id(uuidv4)
    userId: references=user.id on_delete=cascade index
    text: string
    completed: boolean default=false
`);

export type DB = InferSchema<typeof schema>;
```

`createMigrator([schema])` and `paranorm<DB>()` use that same authored value — no dual schema.

### Runtime tips

- Own migrations with ParanORM; point Better Auth at the same database.
- On D1 / celld, set `advanced.database.validateSchema: false` — Better Auth’s check uses `pragma_table_info(?)`, which D1 rejects (`SQLITE_AUTH`).
- When you enable another plugin, copy its fields from Better Auth’s docs/schema into your YAML and bump `_version`.
- Older `_extends: [auth]` / `_auth` configs are gone: paste the tables above (or the subset you need) and bump `_version`.

### Built-in macros that remain

- `_extends: [idempotency]` — `paranorm_idempotency` for `once()`
- `_extends: [files]` — file metadata + attachment pivots (`_files` required)
