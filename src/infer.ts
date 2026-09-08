import type { ColumnType, Generated } from "./column-type.ts";
import { parseSchema } from "./parser.ts";
import type { AuthoredSchema } from "./types.ts";

/**
 * Runtime counterpart of `DedentSource`: drop leading newlines, then strip the
 * indent of the first remaining line from every line that has that prefix.
 * Unlike package `dedent`, column-0 keys do not strip child indentation.
 */
const dedentSchemaSource = (source: string): string => {
  let content = source;
  while (content.startsWith("\r\n")) {
    content = content.slice(2);
  }
  while (content.startsWith("\n")) {
    content = content.slice(1);
  }
  let prefix = "";
  for (const char of content) {
    if (char === " " || char === "\t") {
      prefix += char;
      continue;
    }
    break;
  }
  if (!prefix) {
    return content;
  }
  return content
    .split("\n")
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
    .join("\n");
};

/** JSON values accepted by a `json` column. */
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

/** Empty table map default for keyof merging without using the `{}` type. */
type EmptyTableMap = Record<never, never>;

type TrimLeft<S extends string> = S extends ` ${infer TrimLeftRest}`
  ? TrimLeft<TrimLeftRest>
  : S extends `\t${infer TrimLeftRest}`
    ? TrimLeft<TrimLeftRest>
    : S;
type TrimRight<S extends string> = S extends `${infer TrimRightRest} `
  ? TrimRight<TrimRightRest>
  : S extends `${infer TrimRightRest}\t`
    ? TrimRight<TrimRightRest>
    : S extends `${infer TrimRightRest}\r`
      ? TrimRight<TrimRightRest>
      : S;
type Trim<S extends string> = TrimLeft<TrimRight<S>>;
type DropLeadingBlankLines<S extends string> =
  S extends `\r\n${infer DropLeadingRest}`
    ? DropLeadingBlankLines<DropLeadingRest>
    : S extends `\n${infer DropLeadingRest}`
      ? DropLeadingBlankLines<DropLeadingRest>
      : S;
type LeadingIndent<
  S extends string,
  Prefix extends string = "",
> = S extends ` ${infer LeadingIndentSpaceRest}`
  ? LeadingIndent<LeadingIndentSpaceRest, `${Prefix} `>
  : S extends `\t${infer LeadingIndentTabRest}`
    ? LeadingIndent<LeadingIndentTabRest, `${Prefix}\t`>
    : Prefix;
type StripIndent<Line extends string, Prefix extends string> = Prefix extends ""
  ? Line
  : Line extends `${Prefix}${infer StripIndentRest}`
    ? StripIndentRest
    : Line;
/** Tail-recursive so Better Auth–sized YAML does not hit TS2589 on dedent alone. */
type StripLineIndent<
  S extends string,
  Prefix extends string,
  Acc extends string = "",
> = S extends `${infer StripLineLine}\n${infer StripLineRest}`
  ? StripLineIndent<
      StripLineRest,
      Prefix,
      `${Acc}${StripIndent<StripLineLine, Prefix>}\n`
    >
  : `${Acc}${StripIndent<S, Prefix>}`;
type DedentSource<Source extends string> =
  DropLeadingBlankLines<Source> extends infer Content extends string
    ? StripLineIndent<Content, LeadingIndent<Content>>
    : Source;
type BeforeComment<S extends string> = S extends `${infer V}#${string}`
  ? TrimRight<V>
  : S;
/** Cheap intersection merge during parse; flatten once in `InferDatabase`. */
type Merge<A, B> = Omit<A, keyof B> & B;
type Simplify<T> = {
  [K in keyof T]: T[K];
} extends infer O
  ? { [K in keyof O]: O[K] }
  : never;
type AddTable<Tables, Name extends string> = Name extends keyof Tables
  ? Tables
  : Tables & { [K in Name]: EmptyTableMap };
type AddColumn<
  Tables,
  Table extends string,
  Name extends string,
  Def extends string,
> = Table extends keyof Tables
  ? Merge<
      Tables,
      Record<
        Table,
        Merge<Tables[Table], Record<Name, Trim<BeforeComment<Def>>>>
      >
    >
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
  Tables = EmptyTableMap,
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
type ListItems<Value extends string> = Value extends `[${infer Items}]`
  ? SplitComma<Items>
  : never;
type SplitComma<S extends string> = S extends `${infer Head},${infer Tail}`
  ? Trim<Head> | SplitComma<Tail>
  : Trim<S>;
type Extensions<Source extends string> = ListItems<
  SourceLineValue<Source, "_extends">
>;
type HasExtension<Source extends string, Name extends string> =
  Name extends Extensions<Source> ? true : false;

interface FileRaw<Owned extends boolean> {
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
    Owned extends true ? { userId: "references=user.id" } : EmptyTableMap
  >;
}
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
  : EmptyTableMap;
type FilesOwned<Source extends string> = [
  SourceLineValue<Source, "owner">,
] extends [never]
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
    : EmptyTableMap;

type RawTables<Source extends string> = Merge<
  FilesTables<Source>,
  ParseExplicitTables<Source>
>;
type FirstToken<Definition extends string> =
  Definition extends `${infer Token} ${string}` ? Token : Definition;
type IsNullable<Definition extends string> =
  FirstToken<Definition> extends `${string}?` ? true : false;
type IsGenerated<Definition extends string> =
  FirstToken<Definition> extends `id${string}`
    ? true
    : Definition extends `${string} default=${string}`
      ? true
      : false;
type EnumValues<Definition extends string> =
  Definition extends `${string}enum=[${infer Values}]${string}`
    ? SplitComma<Values>
    : never;
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
type Scalar<Tables, Definition extends string> = [
  EnumValues<Definition>,
] extends [never]
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
export type InferDatabase<Source extends string> =
  DedentSource<Source> extends infer Dedented extends string
    ? RawTables<Dedented> extends infer Tables
      ? Simplify<{
          [Table in keyof Tables]: Simplify<{
            [
              Column in keyof Tables[Table]
            ]: Tables[Table][Column] extends string
              ? SchemaColumn<Tables, Tables[Table][Column]>
              : never;
          }>;
        }>
      : never
    : never;

/** A parsed runtime schema carrying its inferred database type. */
export type TypedSchema<Source extends string> = AuthoredSchema & {
  readonly source: Source;
  readonly $database: InferDatabase<Source>;
};

/**
 * Parses a literal YAML schema and preserves enough type information for the ORM.
 * Keep the argument inline or use `as const`; a widened `string` cannot be inferred.
 */
export const defineSchema = <const Source extends string>(
  source: Source
): TypedSchema<DedentSource<Source>> => {
  // SAFETY: dedentSchemaSource mirrors DedentSource; only leading blank lines / shared indent are removed.
  const normalized = dedentSchemaSource(source) as DedentSource<Source>;
  const parsed = Object.assign(parseSchema(normalized), {
    source: normalized,
  });
  // SAFETY: parseSchema returns AuthoredSchema; source ties the result to Source for inference.
  return parsed as TypedSchema<DedentSource<Source>>;
};

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
export function schema(
  strings: TemplateStringsArray,
  ...values: never[]
): TaggedSchema;
export function schema(
  strings: TemplateStringsArray,
  ...values: unknown[]
): TaggedSchema {
  if (values.length) {
    throw new Error("schema tagged templates do not support interpolation");
  }
  const source = dedentSchemaSource(strings[0] ?? "");
  return Object.assign(parseSchema(source), { source });
}

/** Extracts the inferred database interface from `defineSchema`'s return type. */
export type InferSchema<Schema> =
  Schema extends TypedSchema<infer Source> ? InferDatabase<Source> : never;
