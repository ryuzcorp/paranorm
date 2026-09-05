export const COLUMN_TYPES = [
  "id",
  "string",
  "int",
  "bigint",
  "decimal",
  "boolean",
  "timestamp",
  "date",
  "json",
  "binary",
] as const;
export type ColumnKind = (typeof COLUMN_TYPES)[number];
export type AccessPolicy = "public" | "authenticated" | "owner";
export type AccessAction = "list" | "create" | "update" | "delete";

export type ReferentialAction =
  | "cascade"
  | "set null"
  | "restrict"
  | "no action";

export interface Reference {
  column: string;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  table: string;
}

export type DefaultValue =
  | { kind: "keyword"; value: string }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "sql"; value: string };

export interface ColumnDefinition {
  compositeUnique?: string[];
  dataType: string;
  default?: DefaultValue;
  enumValues?: string[];
  generation?: "cuid" | "uuidv4" | "auto-increment";
  index: boolean;
  kind: ColumnKind;
  multiple?: boolean;
  name: string;
  nullable: boolean;
  primaryKey: boolean;
  references?: Reference;
  source: string;
  unique: boolean;
}

export interface RelationDefinition {
  column?: string;
  kind: "belongs_to" | "has_many";
  name: string;
  table: string;
}

export interface AccessDefinition {
  create: AccessPolicy;
  delete: AccessPolicy;
  list: AccessPolicy;
  ownerColumn?: string;
  update: AccessPolicy;
}

export interface TableDefinition {
  access?: AccessDefinition;
  columns: Record<string, ColumnDefinition>;
  name: string;
  relations: Record<string, RelationDefinition>;
  uniqueConstraints: string[][];
}

/** Nested YAML / macro configuration values. */
export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

export interface AuthoredSchema {
  extends: string[];
  extensions: Record<string, YamlValue>;
  tableOrder: string[];
  tables: Record<string, TableDefinition>;
  version: string;
}

export interface SchemaMacroContext {
  config: YamlValue;
}
export type SchemaMacro = (
  context: SchemaMacroContext
) => Record<string, YamlValue>;
export type SchemaMacroRegistry = Record<string, SchemaMacro>;

export interface SchemaSource {
  content: string | YamlValue;
  name?: string;
}

export interface SchemaDiff {
  addedColumns: { column: ColumnDefinition; table: string }[];
  addedIndexes: { column: string; table: string }[];
  addedTables: TableDefinition[];
  addedUniqueConstraints: { columns: string[]; table: string }[];
  changedColumns: {
    from: ColumnDefinition;
    table: string;
    to: ColumnDefinition;
  }[];
  fromVersion?: string;
  removedColumns: { column: ColumnDefinition; table: string }[];
  removedIndexes: { column: string; table: string }[];
  removedTables: TableDefinition[];
  removedUniqueConstraints: { columns: string[]; table: string }[];
  toVersion: string;
}

export interface ApplySchemaOptions {
  allowDestructive?: boolean;
}
