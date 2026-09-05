import dedent from "dedent";

import type { ColumnType, Generated } from "./column-type.ts";
import { parseSchema } from "./parser.ts";
import type { AuthoredSchema } from "./types.ts";

/** JSON values accepted by a `json` column. */
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

type TrimLeft<S extends string> = S extends ` ${infer R}` | `\t${infer R}` ? TrimLeft<R> : S;
type TrimRight<S extends string> = S extends `${infer R} ` | `${infer R}\t` | `${infer R}\r`
  ? TrimRight<R>
  : S;
type Trim<S extends string> = TrimLeft<TrimRight<S>>;
type DropLeadingBlankLines<S extends string> = S extends `\r\n${infer R}` | `\n${infer R}`
  ? DropLeadingBlankLines<R>
  : S;
type LeadingIndent<S extends string, Prefix extends string = ""> = S extends ` ${infer R}`
  ? LeadingIndent<R, `${Prefix} `>
  : S extends `\t${infer R}`
    ? LeadingIndent<R, `${Prefix}\t`>
    : Prefix;
type StripIndent<Line extends string, Prefix extends string> = Prefix extends ""
  ? Line
  : Line extends `${Prefix}${infer R}`
    ? R
    : Line;
type StripLineIndent<
  S extends string,
  Prefix extends string,
> = S extends `${infer Line}\n${infer Rest}`
  ? `${StripIndent<Line, Prefix>}\n${StripLineIndent<Rest, Prefix>}`
  : StripIndent<S, Prefix>;
type DedentSource<Source extends string> =
  DropLeadingBlankLines<Source> extends infer Content extends string
    ? StripLineIndent<Content, LeadingIndent<Content>>
    : Source;
type BeforeComment<S extends string> = S extends `${infer V}#${string}` ? TrimRight<V> : S;
type Merge<A, B> = Omit<A, keyof B> & B;
type AddTable<Tables, Name extends string> = Name extends keyof Tables
  ? Tables
  : Tables & Record<Name, {}>;
type AddColumn<
  Tables,
  Table extends string,
  Name extends string,
  Def extends string,
> = Table extends keyof Tables
  ? Merge<Tables, Record<Table, Merge<Tables[Table], Record<Name, Trim<BeforeComment<Def>>>>>>
  : Tables;

type ParseLine<Line extends string, Tables, Current extends string | never> =
  Trim<BeforeComment<Line>> extends ""
    ? [Tables, Current]
    : Line extends ` ${string}`
      ? Current extends string
        ? Line extends `  ${infer Rest}`
          ? Rest extends ` ${string}` | `\t${string}`
            ? [Tables, Current]
            : Trim<BeforeComment<Rest>> extends `${infer Name}:${infer Def}`
              ? Name extends `_${string}`
                ? [Tables, Current]
                : [AddColumn<Tables, Current, Trim<Name>, Def>, Current]
              : [Tables, Current]
          : [Tables, Current]
        : [Tables, Current]
      : Trim<BeforeComment<Line>> extends `${infer Name}:${string}`
        ? Name extends `_${string}`
          ? [Tables, never]
          : [AddTable<Tables, Trim<Name>>, Trim<Name>]
        : [Tables, Current];

type ParseExplicitTables<
  Source extends string,
  Tables = {},
  Current extends string | never = never,
> = Source extends `${infer Line}\n${infer Rest}`
  ? ParseLine<Line, Tables, Current> extends [
      infer NextTables,
      infer NextCurrent extends string | never,
    ]
    ? ParseExplicitTables<Rest, NextTables, NextCurrent>
    : never
  : ParseLine<Source, Tables, Current>[0];

type SourceLineValue<
  Source extends string,
  Key extends string,
> = Source extends `${infer Line}\n${infer Rest}`
  ? Trim<BeforeComment<Line>> extends `${Key}:${infer Value}`
    ? Trim<Value>
    : SourceLineValue<Rest, Key>
  : Trim<BeforeComment<Source>> extends `${Key}:${infer Value}`
    ? Trim<Value>
    : never;
type ListItems<Value extends string> = Value extends `[${infer Items}]` ? SplitComma<Items> : never;
type SplitComma<S extends string> = S extends `${infer Head},${infer Tail}`
  ? Trim<Head> | SplitComma<Tail>
  : Trim<S>;
type Extensions<Source extends string> = ListItems<SourceLineValue<Source, "_extends">>;
type HasExtension<Source extends string, Name extends string> =
  Name extends Extensions<Source> ? true : false;

type AuthRoleDefinition<Source extends string> = [SourceLineValue<Source, "roles">] extends [never]
  ? "string default=user"
  : `string default=user enum=${SourceLineValue<Source, "roles">} multiple`;
type AuthRaw<Source extends string> = {
  user: {
    id: "id";
    name: "string";
    email: "string unique";
    emailVerified: "boolean default=false";
    image: "string?";
    role: AuthRoleDefinition<Source>;
    banned: "boolean default=false";
    banReason: "string?";
    banExpires: "timestamp?";
    createdAt: "timestamp default=now";
    updatedAt: "timestamp default=now";
  };
  session: {
    id: "id";
    expiresAt: "timestamp";
    token: "string unique";
    ipAddress: "string?";
    userAgent: "string?";
    userId: "references=user.id";
    impersonatedBy: "string?";
    createdAt: "timestamp default=now";
    updatedAt: "timestamp default=now";
  };
  account: {
    id: "id";
    accountId: "string";
    providerId: "string";
    userId: "references=user.id";
    accessToken: "string?";
    refreshToken: "string?";
    idToken: "string?";
    accessTokenExpiresAt: "timestamp?";
    refreshTokenExpiresAt: "timestamp?";
    scope: "string?";
    password: "string?";
    createdAt: "timestamp default=now";
    updatedAt: "timestamp default=now";
  };
  verification: {
    id: "id";
    identifier: "string";
    value: "string";
    expiresAt: "timestamp";
    createdAt: "timestamp default=now";
    updatedAt: "timestamp default=now";
  };
};
type ApiKeyRaw = {
  apikey: {
    id: "id";
    configId: "string default=default";
    name: "string?";
    start: "string?";
    prefix: "string?";
    key: "string";
    referenceId: "references=user.id";
    refillInterval: "int?";
    refillAmount: "int?";
    lastRefillAt: "timestamp?";
    enabled: "boolean default=true";
    rateLimitEnabled: "boolean default=true";
    rateLimitTimeWindow: "int?";
    rateLimitMax: "int?";
    requestCount: "int default=0";
    remaining: "int?";
    lastRequest: "timestamp?";
    expiresAt: "timestamp?";
    permissions: "string?";
    metadata: "string?";
    createdAt: "timestamp default=now";
    updatedAt: "timestamp default=now";
  };
};
type ApiKeysEnabled<Source extends string> = [SourceLineValue<Source, "api_keys">] extends [never]
  ? false
  : SourceLineValue<Source, "api_keys"> extends "true"
    ? true
    : false;
type AuthTables<Source extends string> =
  HasExtension<Source, "auth"> extends true
    ? Merge<AuthRaw<Source>, ApiKeysEnabled<Source> extends true ? ApiKeyRaw : {}>
    : {};

type FileRaw<Owned extends boolean> = {
  file: Merge<
    {
      id: "id";
      key: "string unique";
      name: "string";
      type: "string";
      size: "int";
      createdAt: "timestamp default=now";
      updatedAt: "timestamp default=now";
    },
    Owned extends true ? { userId: "references=user.id" } : {}
  >;
};
type AttachmentRaw<Entity extends string> = Record<
  `${Entity}_file`,
  {
    id: "id";
    fileId: "references=file.id";
    entityId: `references=${Entity}.id`;
    role: "string?";
    position: "int default=0";
    createdAt: "timestamp default=now";
    updatedAt: "timestamp default=now";
  }
>;
type AttachmentTables<Entities extends string> = Entities extends unknown
  ? AttachmentRaw<Entities>
  : {};
type FilesOwned<Source extends string> = [SourceLineValue<Source, "owner">] extends [never]
  ? true
  : SourceLineValue<Source, "owner"> extends "false"
    ? false
    : true;
type FilesTables<Source extends string> =
  HasExtension<Source, "files"> extends true
    ? Merge<
        FileRaw<FilesOwned<Source>>,
        AttachmentTables<ListItems<SourceLineValue<Source, "attach_to">>>
      >
    : {};

type RawTables<Source extends string> = Merge<
  Merge<AuthTables<Source>, FilesTables<Source>>,
  ParseExplicitTables<Source>
>;
type FirstToken<Definition extends string> = Definition extends `${infer Token} ${string}`
  ? Token
  : Definition;
type IsNullable<Definition extends string> =
  FirstToken<Definition> extends `${string}?` ? true : false;
type IsGenerated<Definition extends string> =
  FirstToken<Definition> extends `id${string}`
    ? true
    : Definition extends `${string} default=${string}`
      ? true
      : false;
type EnumValues<Definition extends string> =
  Definition extends `${string}enum=[${infer Values}]${string}` ? SplitComma<Values> : never;
type ReferenceTarget<Definition extends string> =
  Definition extends `${string}references=${infer Target} ${string}`
    ? Target
    : Definition extends `${string}references=${infer Target}`
      ? Target
      : never;

type ScalarFromToken<Token extends string> = Token extends
  | `id(bigint)${string}`
  | `bigint${string}`
  | `decimal(${string})${string}`
  ? string
  : Token extends `id${string}` | `string${string}`
    ? string
    : Token extends `int${string}`
      ? number
      : Token extends `boolean${string}`
        ? boolean
        : Token extends `timestamp${string}` | `date${string}`
          ? Date
          : Token extends `json${string}`
            ? JSONValue
            : Token extends `binary${string}`
              ? Uint8Array
              : unknown;

type ReferencedScalar<
  Tables,
  Target extends string,
> = Target extends `${infer Table}.${infer Column}`
  ? Table extends keyof Tables
    ? Column extends keyof Tables[Table]
      ? Tables[Table][Column] extends string
        ? Scalar<Tables, Tables[Table][Column]>
        : unknown
      : unknown
    : unknown
  : unknown;
type Scalar<Tables, Definition extends string> = [EnumValues<Definition>] extends [never]
  ? [ReferenceTarget<Definition>] extends [never]
    ? ScalarFromToken<FirstToken<Definition>>
    : ReferencedScalar<Tables, ReferenceTarget<Definition>>
  : EnumValues<Definition>;
type SelectValue<Tables, Definition extends string> =
  IsNullable<Definition> extends true
    ? Scalar<Tables, Definition> | null
    : Scalar<Tables, Definition>;
type SchemaColumn<Tables, Definition extends string> =
  IsGenerated<Definition> extends true
    ? Generated<SelectValue<Tables, Definition>>
    : IsNullable<Definition> extends true
      ? ColumnType<
          SelectValue<Tables, Definition>,
          SelectValue<Tables, Definition> | undefined,
          SelectValue<Tables, Definition>
        >
      : ColumnType<
          SelectValue<Tables, Definition>,
          SelectValue<Tables, Definition>,
          SelectValue<Tables, Definition>
        >;

/** Infers the database interface from a literal YAML schema string. */
export type InferDatabase<Source extends string> = {
  [Table in keyof RawTables<DedentSource<Source>>]: {
    [Column in keyof RawTables<DedentSource<Source>>[Table]]: RawTables<
      DedentSource<Source>
    >[Table][Column] extends string
      ? SchemaColumn<
          RawTables<DedentSource<Source>>,
          RawTables<DedentSource<Source>>[Table][Column]
        >
      : never;
  };
};

/** A parsed runtime schema carrying its inferred database type. */
export type TypedSchema<Source extends string> = AuthoredSchema & {
  readonly source: Source;
  readonly $database: InferDatabase<Source>;
};

/**
 * Parses a literal YAML schema and preserves enough type information for the ORM.
 * Keep the argument inline or use `as const`; a widened `string` cannot be inferred.
 */
export function defineSchema<const Source extends string>(
  source: Source,
): TypedSchema<DedentSource<Source>> {
  const normalized = (
    /^(?:\r?\n|[ \t])/.test(source) ? dedent(source) : source
  ) as DedentSource<Source>;
  return Object.assign(parseSchema(normalized), { source: normalized }) as TypedSchema<
    DedentSource<Source>
  >;
}

/** Runtime schema returned by the YAML tagged template. */
export type TaggedSchema = AuthoredSchema & { readonly source: string };

/**
 * YAML-friendly tagged-template form. Interpolation is intentionally forbidden so the
 * parsed document is a single immutable schema source.
 *
 * TypeScript does not expose tagged-template text as a string-literal type. The return
 * type therefore deliberately does not pretend to support `InferSchema`; use
 * `defineSchema(yaml as const)` when compile-time inference is required.
 */
export function schema(strings: TemplateStringsArray, ...values: never[]): TaggedSchema;
export function schema(strings: TemplateStringsArray, ...values: unknown[]): TaggedSchema {
  if (values.length) throw new Error("schema tagged templates do not support interpolation");
  const source = dedent(strings[0] ?? "");
  return Object.assign(parseSchema(source), { source });
}

/** Extracts the inferred database interface from `defineSchema`'s return type. */
export type InferSchema<Schema> =
  Schema extends TypedSchema<infer Source> ? InferDatabase<Source> : never;
