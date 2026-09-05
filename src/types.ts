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

export type ReferentialAction = "cascade" | "set null" | "restrict" | "no action";
export interface Reference {
  table: string;
  column: string;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}
export interface ColumnDefinition {
  name: string;
  kind: ColumnKind;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  generation?: "cuid" | "uuidv4" | "auto-increment";
  unique: boolean;
  index: boolean;
  enumValues?: string[];
  multiple?: boolean;
  compositeUnique?: string[];
  default?: { kind: "keyword" | "literal" | "sql"; value: unknown };
  references?: Reference;
  source: string;
}

export interface RelationDefinition {
  name: string;
  kind: "belongs_to" | "has_many";
  table: string;
  column?: string;
}

export interface AccessDefinition {
  list: AccessPolicy;
  create: AccessPolicy;
  update: AccessPolicy;
  delete: AccessPolicy;
  ownerColumn?: string;
}

export interface TableDefinition {
  name: string;
  columns: Record<string, ColumnDefinition>;
  relations: Record<string, RelationDefinition>;
  access?: AccessDefinition;
  uniqueConstraints: string[][];
}

export interface AuthoredSchema {
  version: string;
  extends: string[];
  extensions: Record<string, unknown>;
  tables: Record<string, TableDefinition>;
  tableOrder: string[];
}

export interface SchemaMacroContext {
  config: unknown;
}
export type SchemaMacro = (context: SchemaMacroContext) => Record<string, unknown>;
export type SchemaMacroRegistry = Record<string, SchemaMacro>;

export interface SchemaSource {
  name?: string;
  content: string | Record<string, unknown>;
}
export interface SchemaDiff {
  fromVersion?: string;
  toVersion: string;
  addedTables: TableDefinition[];
  removedTables: TableDefinition[];
  addedColumns: Array<{ table: string; column: ColumnDefinition }>;
  removedColumns: Array<{ table: string; column: ColumnDefinition }>;
  changedColumns: Array<{
    table: string;
    from: ColumnDefinition;
    to: ColumnDefinition;
  }>;
  addedUniqueConstraints: Array<{ table: string; columns: string[] }>;
  removedUniqueConstraints: Array<{ table: string; columns: string[] }>;
  addedIndexes: Array<{ table: string; column: string }>;
  removedIndexes: Array<{ table: string; column: string }>;
}

export interface ApplySchemaOptions {
  allowDestructive?: boolean;
}
