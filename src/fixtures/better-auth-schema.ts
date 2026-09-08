import { createMigrator, defineSchema } from "../index.ts";
import type { InferSchema, Insertable, Selectable } from "../index.ts";

/**
 * DOCS.md Better Auth recipe (admin + passkey) plus one app table.
 * Kept as a typecheck fixture so tsc --strict guards against TS2589 regressions.
 */
export const betterAuthSchema = defineSchema(`
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

export type BetterAuthDB = InferSchema<typeof betterAuthSchema>;
export type Task = Selectable<BetterAuthDB["tasks"]>;
export type NewTask = Insertable<BetterAuthDB["tasks"]>;
export type User = Selectable<BetterAuthDB["user"]>;
export type Session = Selectable<BetterAuthDB["session"]>;

export const betterAuthMigrator = createMigrator([betterAuthSchema]);

/** Slightly larger than the DOCS recipe (extra plugin-ish tables/columns). */
export const betterAuthStressSchema = defineSchema(`
  _version: "1.0.1"
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
    twoFactorEnabled: boolean default=false
    username: string? unique
    displayUsername: string?
    createdAt: timestamp default=now
    updatedAt: timestamp default=now

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
    activeOrganizationId: string?

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

  verification:
    id: id
    identifier: string index
    value: string
    expiresAt: timestamp
    createdAt: timestamp default=now
    updatedAt: timestamp default=now

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

  twoFactor:
    id: id
    secret: string
    backupCodes: string
    userId: references=user.id on_delete=cascade index

  organization:
    id: id
    name: string
    slug: string unique
    logo: string?
    createdAt: timestamp default=now
    metadata: string?

  member:
    id: id
    organizationId: references=organization.id on_delete=cascade index
    userId: references=user.id on_delete=cascade index
    role: string
    createdAt: timestamp default=now

  tasks:
    id: id(uuidv4)
    userId: references=user.id on_delete=cascade index
    organizationId: references=organization.id on_delete=cascade index
    text: string
    completed: boolean default=false
    priority: int default=0
    dueAt: timestamp?
`);

export type StressDB = InferSchema<typeof betterAuthStressSchema>;
export type StressTask = Selectable<StressDB["tasks"]>;
export type StressMember = Selectable<StressDB["member"]>;
