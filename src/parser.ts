import { parseYAML } from "confbox";

import type {
  AccessAction,
  AccessDefinition,
  AccessPolicy,
  AuthoredSchema,
  ColumnDefinition,
  ColumnKind,
  ReferentialAction,
  RelationDefinition,
  SchemaMacroRegistry,
  TableDefinition,
  YamlValue,
} from "./types.ts";
import { COLUMN_TYPES } from "./types.ts";

const ACTIONS: AccessAction[] = ["list", "create", "update", "delete"];
const REFERENTIAL_ACTIONS: ReferentialAction[] = [
  "cascade",
  "no action",
  "restrict",
  "set null",
];
const TYPE_PATTERN =
  /^(?<rawType>id(?:\((?<idParam>varchar\(\d+\)|bigint|uuidv4)\))?|decimal\((?<precision>\d+)\s*,\s*(?<scale>\d+)\)|string|int|bigint|boolean|timestamp|date|json|binary)(?<nullable>\?)?$/u;
const SQL_DEFAULT_PATTERN =
  /^sql\((?<quote>["'])(?<value>[\s\S]*)\k<quote>\)$/u;
const NUMERIC_DEFAULT_PATTERN = /^(?<num>-?\d+(?:\.\d+)?)$/u;
const REFERENCE_PATTERN =
  /^(?<table>[A-Za-z_][\w]*)\.(?<column>[A-Za-z_][\w]*)$/u;
const RELATION_PATTERN =
  /^(?<kind>belongs_to|has_many)=(?<table>[A-Za-z_][\w]*)$/u;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u;
const YAML_KEY_PATTERN =
  /^(?<indent>\s*)(?:"(?<qkey>[A-Za-z_][\w]*)"|(?<key>[A-Za-z_][\w]*))\s*:/u;
const WHITESPACE_PATTERN = /\s/u;
const PATH_INDEX_PATTERN = /\[\d+\]$/u;

const COLUMN_DATA_TYPES: Partial<Record<ColumnKind, string>> = {
  bigint: "bigint",
  binary: "blob",
  boolean: "boolean",
  date: "date",
  int: "integer",
  json: "json",
  string: "varchar(255)",
  timestamp: "timestamp",
};

interface SchemaDocument {
  [key: string]: YamlValue;
}

interface TypePatternGroups {
  idParam?: string;
  nullable?: string;
  precision?: string;
  rawType: string;
  scale?: string;
}

export interface ParseSchemaOptions {
  macros?: SchemaMacroRegistry;
  /** Original YAML/JSON text when `input` is already a parsed object. */
  sourceText?: string;
  sourceName?: string;
}

const SCHEMA_ISSUE_NAME = "SchemaIssue";

interface SchemaIssueFields {
  path: string;
}

const isSchemaIssue = (error: Error): error is Error & SchemaIssueFields => {
  if (error.name !== SCHEMA_ISSUE_NAME || !("path" in error)) {
    return false;
  }
  return String(error.path) === error.path;
};

const fail = (message: string, path = ""): never => {
  const error = new Error(`Invalid schema: ${message}`);
  error.name = SCHEMA_ISSUE_NAME;
  Object.assign(error, { path } satisfies SchemaIssueFields);
  throw error;
};

const isColumnKind = (value: string): value is ColumnKind =>
  // SAFETY: membership check narrows to ColumnKind literals.
  (COLUMN_TYPES as readonly string[]).includes(value);

const isAccessPolicy = (value: YamlValue): value is AccessPolicy =>
  value === "authenticated" || value === "owner" || value === "public";

const isAccessAction = (value: string): value is AccessAction =>
  // SAFETY: membership check narrows to AccessAction literals.
  (ACTIONS as readonly string[]).includes(value);

const isReferentialAction = (value: string): value is ReferentialAction =>
  // SAFETY: membership check narrows to ReferentialAction literals.
  (REFERENTIAL_ACTIONS as readonly string[]).includes(value);

const isRelationKind = (value: string): value is RelationDefinition["kind"] =>
  value === "belongs_to" || value === "has_many";

const isYamlMapping = (value: YamlValue): value is SchemaDocument =>
  value !== null && Object(value) === value && !Array.isArray(value);

export { isYamlMapping };

const expectYamlMapping = (value: YamlValue, at: string): SchemaDocument => {
  if (!isYamlMapping(value)) {
    return fail(`${at} must be a mapping`, at);
  }
  return value;
};

const expectYamlString = (value: YamlValue, at: string): string => {
  if (String(value) !== value) {
    return fail(`${at} must be a string`, at);
  }
  return value;
};

const expectYamlStringArray = (value: YamlValue, at: string): string[] => {
  if (!Array.isArray(value)) {
    return fail(`${at} must be an array`, at);
  }
  return value.map((item: YamlValue, index: number) =>
    expectYamlString(item, `${at}[${index}]`)
  );
};

const expectYamlBoolean = (value: YamlValue, at: string): boolean => {
  if (value !== true && value !== false) {
    return fail(`${at} must be a boolean`, at);
  }
  return value;
};

const parseSchemaDocumentInput = (
  input: string | SchemaDocument
): SchemaDocument => {
  if (isYamlMapping(input)) {
    return input;
  }
  // SAFETY: confbox parseYAML returns a YAML-compatible value tree.
  const parsed = parseYAML(input) as YamlValue;
  return expectYamlMapping(parsed, "document");
};

const tokenize = (input: string, path: string): string[] => {
  const tokens: string[] = [];
  let brackets = 0;
  let current = "";
  let parens = 0;
  let quote = "";
  for (const char of input.trim()) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") {
      parens += 1;
    } else if (char === ")") {
      parens -= 1;
    }
    if (char === "[") {
      brackets += 1;
    } else if (char === "]") {
      brackets -= 1;
    }
    if (WHITESPACE_PATTERN.test(char) && parens === 0 && brackets === 0) {
      if (current) {
        tokens.push(current);
      }
      current = "";
    } else {
      current += char;
    }
  }
  if (quote || parens !== 0 || brackets !== 0) {
    fail(`unbalanced column definition '${input}'`, path);
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
};

const parseDefault = (
  raw: string
): NonNullable<ColumnDefinition["default"]> => {
  const sqlMatch = SQL_DEFAULT_PATTERN.exec(raw);
  if (sqlMatch?.groups?.value) {
    return { kind: "sql", value: sqlMatch.groups.value };
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return { kind: "literal", value: raw.slice(1, -1) };
  }
  if (raw === "true" || raw === "false") {
    return { kind: "literal", value: raw === "true" };
  }
  if (NUMERIC_DEFAULT_PATTERN.test(raw)) {
    return { kind: "literal", value: Number(raw) };
  }
  return { kind: "keyword", value: raw };
};

const readTypePatternGroups = (
  match: RegExpExecArray
): TypePatternGroups | undefined => {
  const { groups } = match;
  if (!groups?.rawType) {
    return undefined;
  }
  const result: TypePatternGroups = { rawType: groups.rawType };
  if (groups.idParam !== undefined) {
    result.idParam = groups.idParam;
  }
  if (groups.nullable !== undefined) {
    result.nullable = groups.nullable;
  }
  if (groups.precision !== undefined) {
    result.precision = groups.precision;
  }
  if (groups.scale !== undefined) {
    result.scale = groups.scale;
  }
  return result;
};

const resolveIdColumn = (
  groups: TypePatternGroups
): Pick<ColumnDefinition, "dataType" | "generation" | "kind"> => {
  const parameter = groups.idParam;
  if (!parameter) {
    return {
      dataType: "varchar(255)",
      generation: "cuid",
      kind: "id",
    };
  }
  if (parameter === "uuidv4") {
    return { dataType: "uuid", generation: "uuidv4", kind: "id" };
  }
  if (parameter === "bigint") {
    return {
      dataType: "bigint",
      generation: "auto-increment",
      kind: "id",
    };
  }
  return { dataType: parameter, generation: "cuid", kind: "id" };
};

const resolveColumnType = (
  groups: TypePatternGroups,
  path: string
): Pick<ColumnDefinition, "dataType" | "generation" | "kind" | "nullable"> => {
  const nullable = Boolean(groups.nullable);
  if (groups.rawType.startsWith("id")) {
    return { ...resolveIdColumn(groups), nullable };
  }
  if (groups.rawType.startsWith("decimal")) {
    const { precision, scale } = groups;
    if (!precision || !scale) {
      fail(`invalid decimal type`, path);
    }
    return {
      dataType: `decimal(${precision},${scale})`,
      kind: "decimal",
      nullable,
    };
  }
  if (!isColumnKind(groups.rawType)) {
    return fail(`unsupported type '${groups.rawType}'`, path);
  }
  const kind = groups.rawType;
  const dataType = COLUMN_DATA_TYPES[kind];
  if (!dataType) {
    return fail(`unsupported type '${kind}'`, path);
  }
  return { dataType, kind, nullable };
};

const applyReferentialAction = (
  column: ColumnDefinition,
  key: string,
  value: string,
  path: string
): void => {
  if (!column.references) {
    return fail(`${key} must follow references`, path);
  }
  const action = value.replaceAll("_", " ");
  if (!isReferentialAction(action)) {
    return fail(`invalid ${key} action '${value}'`, path);
  }
  if (key === "on_delete") {
    column.references.onDelete = action;
  } else {
    column.references.onUpdate = action;
  }
};

const applyEnumToken = (
  column: ColumnDefinition,
  value: string,
  path: string
): void => {
  column.enumValues = value
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!column.enumValues.length) {
    fail(`enum must not be empty`, path);
  }
};

const applyCompositeUniqueToken = (
  column: ColumnDefinition,
  value: string,
  path: string
): void => {
  column.compositeUnique = value
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (column.compositeUnique.length < 2) {
    fail(`composite unique needs at least two columns`, path);
  }
};

const applyReferencesToken = (
  column: ColumnDefinition,
  value: string,
  path: string
): void => {
  const match = REFERENCE_PATTERN.exec(value);
  const table = match?.groups?.table;
  const refColumn = match?.groups?.column;
  if (!table || !refColumn) {
    return fail(`invalid reference '${value}'`, path);
  }
  column.references = { column: refColumn, table };
};

const applyFlagToken = (
  column: ColumnDefinition,
  key: string,
  value: string | undefined
): boolean => {
  if (value !== undefined) {
    return false;
  }
  if (key === "unique") {
    column.unique = true;
    return true;
  }
  if (key === "index") {
    column.index = true;
    return true;
  }
  if (key === "multiple") {
    column.multiple = true;
    return true;
  }
  return false;
};

const applyValueToken = (
  column: ColumnDefinition,
  key: string,
  value: string,
  path: string
): boolean => {
  if (key === "enum" && value.startsWith("[") && value.endsWith("]")) {
    applyEnumToken(column, value, path);
    return true;
  }
  if (key === "unique" && value.startsWith("[") && value.endsWith("]")) {
    applyCompositeUniqueToken(column, value, path);
    return true;
  }
  if (key === "default") {
    column.default = parseDefault(value);
    return true;
  }
  if (key === "references") {
    applyReferencesToken(column, value, path);
    return true;
  }
  if (key === "on_delete" || key === "on_update") {
    applyReferentialAction(column, key, value, path);
    return true;
  }
  return false;
};

const applyColumnToken = (
  column: ColumnDefinition,
  token: string,
  path: string
): void => {
  const separator = token.indexOf("=");
  const key = separator === -1 ? token : token.slice(0, separator);
  const value = separator === -1 ? undefined : token.slice(separator + 1);
  if (applyFlagToken(column, key, value)) {
    return;
  }
  if (value !== undefined && applyValueToken(column, key, value, path)) {
    return;
  }
  fail(`unsupported modifier '${token}'`, path);
};

export const parseColumn = (
  name: string,
  source: YamlValue,
  path: string = name
): ColumnDefinition => {
  const sourceText = expectYamlString(source, path);
  const tokens = tokenize(sourceText, path);
  const first = tokens.shift() ?? "";
  const inferredReference = first.startsWith("references=");
  if (inferredReference) {
    tokens.unshift(first);
  }
  const typeMatch = inferredReference
    ? TYPE_PATTERN.exec("string")
    : TYPE_PATTERN.exec(first);
  const groups = typeMatch ? readTypePatternGroups(typeMatch) : undefined;
  if (!groups) {
    return fail(`unsupported type in '${sourceText}'`, path);
  }
  const resolved = resolveColumnType(groups, path);
  const column: ColumnDefinition = {
    dataType: resolved.dataType,
    index: false,
    kind: resolved.kind,
    name,
    nullable: resolved.nullable,
    primaryKey: resolved.kind === "id",
    source: sourceText,
    unique: false,
  };
  if (resolved.generation !== undefined) {
    column.generation = resolved.generation;
  }
  for (const token of tokens) {
    applyColumnToken(column, token, path);
  }
  return column;
};

const defaultAccessDefinition = (): AccessDefinition => ({
  create: "public",
  delete: "public",
  list: "public",
  update: "public",
});

const parseAccess = (
  raw: YamlValue,
  table: TableDefinition
): AccessDefinition => {
  const accessPath = `${table.name}._access`;
  const value = expectYamlMapping(raw, accessPath);
  const access = defaultAccessDefinition();
  for (const action of ACTIONS) {
    const policy = value[action];
    if (policy !== undefined) {
      if (!isAccessPolicy(policy)) {
        return fail(
          `${accessPath}.${action} has invalid policy '${String(policy)}'`,
          `${accessPath}.${action}`
        );
      }
      access[action] = policy;
    }
  }
  if (value.owner_column !== undefined) {
    const ownerColumn = expectYamlString(
      value.owner_column,
      `${accessPath}.owner_column`
    );
    if (!table.columns[ownerColumn]) {
      fail(
        `${accessPath}.owner_column must name an existing column`,
        `${accessPath}.owner_column`
      );
    }
    access.ownerColumn = ownerColumn;
  }
  if (
    ACTIONS.some((action) => access[action] === "owner") &&
    !access.ownerColumn
  ) {
    fail(`${accessPath} requires owner_column for owner policy`, accessPath);
  }
  for (const key of Object.keys(value)) {
    if (key !== "owner_column" && !isAccessAction(key)) {
      fail(`${accessPath} has unknown key '${key}'`, `${accessPath}.${key}`);
    }
  }
  return access;
};

const filesMacro = (config: YamlValue) => {
  const options = expectYamlMapping(config, "_files");
  const attachTo = expectYamlStringArray(
    options.attach_to ?? [],
    "_files.attach_to"
  );
  if (options.owner !== undefined) {
    expectYamlBoolean(options.owner, "_files.owner");
  }
  const owned = options.owner !== false;
  const file: SchemaDocument = {
    createdAt: "timestamp default=now",
    id: "id",
    key: "string unique",
    name: "string",
    size: "int",
    type: "string",
    updatedAt: "timestamp default=now",
  };
  if (owned) {
    file.userId = "references=user.id on_delete=set_null index";
    file._relations = { user: "belongs_to=user" };
  }
  const attachmentTables = Object.fromEntries(
    attachTo.map((entity) => [
      `${entity}_file`,
      {
        _relations: { entity: `belongs_to=${entity}`, file: "belongs_to=file" },
        createdAt: "timestamp default=now",
        entityId: `references=${entity}.id on_delete=cascade index`,
        fileId: "references=file.id on_delete=cascade index",
        id: "id",
        position: "int default=0",
        role: "string?",
        updatedAt: "timestamp default=now",
      },
    ])
  );
  return { file, ...attachmentTables } satisfies Record<string, YamlValue>;
};

const idempotencyMacro = () =>
  ({
    paranorm_idempotency: {
      created_at: "timestamp default=now",
      key: "id",
    },
  }) satisfies Record<string, YamlValue>;

export const builtinMacros: SchemaMacroRegistry = {
  files: ({ config }) => filesMacro(config),
  idempotency: () => idempotencyMacro(),
};

const validateVersion = (document: SchemaDocument): string => {
  const version = document._version;
  if (version === undefined) {
    return fail("_version must be a semver string", "_version");
  }
  const versionText = expectYamlString(version, "_version");
  if (!SEMVER_PATTERN.test(versionText)) {
    fail("_version must be a semver string", "_version");
  }
  return versionText;
};

const readExtensions = (document: SchemaDocument): string[] => {
  const extensions = document._extends === undefined ? [] : document._extends;
  return expectYamlStringArray(extensions, "_extends");
};

const expandExtensions = (
  document: SchemaDocument,
  extensions: string[],
  macros: SchemaMacroRegistry
): SchemaDocument => {
  const expanded: SchemaDocument = {};
  for (const name of extensions) {
    const macro = macros[name];
    if (!macro) {
      return fail(`unknown extension '${name}'`, "_extends");
    }
    const config = document[`_${name}`] ?? null;
    if (name === "files" && config === null) {
      return fail("files extension requires _files config", "_files");
    }
    Object.assign(expanded, macro({ config }));
  }
  return expanded;
};

const mergeDocumentTables = (
  document: SchemaDocument,
  expanded: SchemaDocument
): void => {
  for (const [key, value] of Object.entries(document)) {
    if (key.startsWith("_")) {
      continue;
    }
    if (expanded[key]) {
      fail(
        `table '${key}' is supplied by an extension and cannot be redefined`,
        key
      );
    }
    expanded[key] = value;
  }
};

const collectUniqueConstraints = (
  name: string,
  columns: TableDefinition["columns"]
): string[][] => {
  const uniqueConstraints: string[][] = [];
  for (const column of Object.values(columns)) {
    if (column.unique) {
      uniqueConstraints.push([column.name]);
    }
    if (!column.compositeUnique) {
      continue;
    }
    const columnPath = `${name}.${column.name}`;
    const local: string[] = column.compositeUnique.map((qualified) => {
      const [owner, field] = qualified.split(".");
      if (owner !== name || !field || !columns[field]) {
        return fail(
          `${columnPath} has invalid composite unique member '${qualified}'`,
          columnPath
        );
      }
      return field;
    });
    if (!local.includes(column.name)) {
      fail(`${columnPath} composite unique must include itself`, columnPath);
    }
    if (
      !uniqueConstraints.some(
        (constraint) => constraint.join("|") === local.join("|")
      )
    ) {
      uniqueConstraints.push(local);
    }
  }
  return uniqueConstraints;
};

const buildTableColumns = (
  name: string,
  raw: YamlValue
): TableDefinition["columns"] => {
  const value = expectYamlMapping(raw, name);
  const columns: TableDefinition["columns"] = {};
  for (const [columnName, definition] of Object.entries(value)) {
    if (!columnName.startsWith("_")) {
      columns[columnName] = parseColumn(
        columnName,
        definition,
        `${name}.${columnName}`
      );
    }
  }
  return columns;
};

const buildTables = (expanded: SchemaDocument) => {
  const tables: Record<string, TableDefinition> = {};
  for (const [name, raw] of Object.entries(expanded)) {
    const columns = buildTableColumns(name, raw);
    tables[name] = {
      columns,
      name,
      relations: {},
      uniqueConstraints: collectUniqueConstraints(name, columns),
    };
  }
  return tables satisfies Record<string, TableDefinition>;
};

const parseRelationDefinition = (
  name: string,
  relationName: string,
  definition: YamlValue,
  tables: Record<string, TableDefinition>
): RelationDefinition => {
  const relationPath = `${name}._relations.${relationName}`;
  const relationSource = expectYamlString(definition, relationPath);
  const match = RELATION_PATTERN.exec(relationSource);
  const kindText = match?.groups?.kind;
  const targetTable = match?.groups?.table;
  if (!kindText || !targetTable || !tables[targetTable]) {
    return fail(
      `${relationPath} is invalid or targets an unknown table`,
      relationPath
    );
  }
  if (!isRelationKind(kindText)) {
    return fail(`${relationPath} has invalid relation kind`, relationPath);
  }
  const relation: RelationDefinition = {
    kind: kindText,
    name: relationName,
    table: targetTable,
  };
  return relation;
};

const assignBelongsToColumn = (
  name: string,
  relationName: string,
  relation: RelationDefinition,
  table: TableDefinition
): void => {
  if (relation.kind !== "belongs_to") {
    return;
  }
  const relationPath = `${name}._relations.${relationName}`;
  const matches = Object.values(table.columns).filter(
    (column) => column.references?.table === relation.table
  );
  if (matches.length !== 1) {
    fail(
      `${relationPath} requires exactly one foreign key to '${relation.table}'`,
      relationPath
    );
  }
  const [match] = matches;
  if (!match) {
    return fail(
      `${relationPath} requires exactly one foreign key to '${relation.table}'`,
      relationPath
    );
  }
  relation.column = match.name;
};

const parseTableRelations = (
  expanded: SchemaDocument,
  tables: Record<string, TableDefinition>
): void => {
  for (const [name, raw] of Object.entries(expanded)) {
    const value = expectYamlMapping(raw, name);
    const table = tables[name];
    if (!table) {
      fail(`table '${name}' was not built`, name);
      return;
    }
    if (value._relations !== undefined) {
      const relations = expectYamlMapping(
        value._relations,
        `${name}._relations`
      );
      for (const [relationName, definition] of Object.entries(relations)) {
        const relation = parseRelationDefinition(
          name,
          relationName,
          definition,
          tables
        );
        assignBelongsToColumn(name, relationName, relation, table);
        table.relations[relationName] = relation;
      }
    }
    if (value._access !== undefined) {
      table.access = parseAccess(value._access, table);
    }
  }
};

const validateColumnReferences = (
  tables: Record<string, TableDefinition>
): void => {
  for (const table of Object.values(tables)) {
    for (const column of Object.values(table.columns)) {
      if (!column.references) {
        continue;
      }
      const columnPath = `${table.name}.${column.name}`;
      const targetTable = tables[column.references.table];
      const targetColumn = targetTable?.columns[column.references.column];
      if (!targetTable || !targetColumn) {
        fail(
          `${columnPath} references missing column '${column.references.table}.${column.references.column}'`,
          columnPath
        );
        continue;
      }
      if (!column.source.trim().startsWith("references=")) {
        continue;
      }
      column.kind = targetColumn.kind;
      column.dataType = targetColumn.dataType;
    }
  }
};

const validateHasManyRelations = (
  tables: Record<string, TableDefinition>
): void => {
  for (const table of Object.values(tables)) {
    for (const relation of Object.values(table.relations)) {
      if (relation.kind !== "has_many") {
        continue;
      }
      const relationPath = `${table.name}._relations.${relation.name}`;
      const target = tables[relation.table];
      if (!target) {
        fail(
          `${relationPath} targets unknown table '${relation.table}'`,
          relationPath
        );
        continue;
      }
      const reverse = Object.values(target.relations).some(
        (candidate) =>
          candidate.kind === "belongs_to" && candidate.table === table.name
      );
      if (!reverse) {
        fail(
          `${relationPath} has no reverse belongs_to on '${relation.table}'`,
          relationPath
        );
      }
    }
  }
};

const computeTableOrder = (
  tables: Record<string, TableDefinition>
): string[] => {
  const pending = new Set(Object.keys(tables));
  const tableOrder: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending].filter((name) => {
      const table = tables[name];
      if (!table) {
        return false;
      }
      return Object.values(table.columns).every(
        (column) => !column.references || !pending.has(column.references.table)
      );
    });
    if (!ready.length) {
      fail(`foreign key cycle between: ${[...pending].join(", ")}`);
    }
    for (const name of ready) {
      pending.delete(name);
      tableOrder.push(name);
    }
  }
  return tableOrder;
};

const collectExtensionConfig = (document: SchemaDocument) => {
  const extensionConfig: Record<string, YamlValue> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key.startsWith("_") && key !== "_extends" && key !== "_version") {
      extensionConfig[key] = value;
    }
  }
  return extensionConfig satisfies Record<string, YamlValue>;
};

const parseSchemaDocument = (
  input: string | SchemaDocument,
  options: { macros?: SchemaMacroRegistry } = {}
): AuthoredSchema => {
  const document = parseSchemaDocumentInput(input);
  const version = validateVersion(document);
  const extensions = readExtensions(document);
  const macros = { ...builtinMacros, ...options.macros };
  const expanded = expandExtensions(document, extensions, macros);
  mergeDocumentTables(document, expanded);
  const tables = buildTables(expanded);
  parseTableRelations(expanded, tables);
  validateColumnReferences(tables);
  validateHasManyRelations(tables);
  const tableOrder = computeTableOrder(tables);
  return {
    extends: extensions,
    extensions: collectExtensionConfig(document),
    tableOrder,
    tables,
    version,
  };
};

export interface SchemaValidationErrorOptions {
  cause?: unknown;
  column?: number;
  line?: number;
  path?: string;
  sourceName?: string;
}

export class SchemaValidationError extends Error {
  readonly column?: number;
  readonly line?: number;
  readonly path: string;
  readonly sourceName: string;

  constructor(message: string, options: SchemaValidationErrorOptions = {}) {
    const sourceName = options.sourceName ?? "schema";
    const path = options.path ?? "";
    const { line, column } = options;
    const hasLocation = line !== undefined && column !== undefined;
    let location = sourceName;
    if (hasLocation) {
      location = `${sourceName}:${line}:${column}`;
    } else if (path) {
      location = `${sourceName}:${path}`;
    }
    super(`${location} ${message}`, {
      cause: options.cause,
    });
    this.name = "SchemaValidationError";
    this.path = path;
    this.sourceName = sourceName;
    if (hasLocation) {
      this.line = line;
      this.column = column;
    }
  }
}

const pathLookupCandidates = (path: string): string[] => {
  const candidates: string[] = [];
  let current = path;
  while (current) {
    candidates.push(current);
    if (PATH_INDEX_PATTERN.test(current)) {
      current = current.replace(PATH_INDEX_PATTERN, "");
      continue;
    }
    const separator = current.lastIndexOf(".");
    if (separator === -1) {
      break;
    }
    current = current.slice(0, separator);
  }
  return candidates;
};

const locateSchemaError = (
  source: string,
  path: string
): { column: number; line: number } | undefined => {
  if (!path) {
    return undefined;
  }
  const candidates = new Set(pathLookupCandidates(path));
  const stack: { indent: number; key: string }[] = [];
  let best: { column: number; line: number; score: number } | undefined;
  for (const [index, line] of source.split("\n").entries()) {
    const match = YAML_KEY_PATTERN.exec(line);
    const indentText = match?.groups?.indent;
    const key = match?.groups?.qkey ?? match?.groups?.key;
    if (indentText === undefined || !key) {
      continue;
    }
    const indent = indentText.replaceAll("\t", "  ").length;
    while (stack.length > 0) {
      const top = stack.at(-1);
      if (!top || top.indent < indent) {
        break;
      }
      stack.pop();
    }
    const keyPath = [...stack.map((entry) => entry.key), key].join(".");
    if (candidates.has(keyPath)) {
      const score = keyPath.length;
      if (score > (best?.score ?? -1)) {
        best = { column: indentText.length + 1, line: index + 1, score };
      }
    }
    stack.push({ indent, key });
  }
  return best ? { column: best.column, line: best.line } : undefined;
};

const wrapSchemaError = (
  error: Error,
  options: ParseSchemaOptions,
  sourceText?: string
): SchemaValidationError => {
  if (error instanceof SchemaValidationError) {
    return error;
  }
  const path = isSchemaIssue(error) ? error.path : "";
  const location =
    sourceText === undefined ? undefined : locateSchemaError(sourceText, path);
  const details: SchemaValidationErrorOptions = {
    cause: error,
    path,
  };
  if (location !== undefined) {
    details.column = location.column;
    details.line = location.line;
  }
  if (options.sourceName !== undefined) {
    details.sourceName = options.sourceName;
  }
  return new SchemaValidationError(error.message, details);
};

export const parseSchema = (
  input: string | SchemaDocument,
  options: ParseSchemaOptions = {}
): AuthoredSchema => {
  const sourceText = isYamlMapping(input) ? options.sourceText : input;
  try {
    return parseSchemaDocument(input, options);
  } catch (error) {
    if (error instanceof Error) {
      throw wrapSchemaError(error, options, sourceText);
    }
    throw wrapSchemaError(new Error(String(error)), options, sourceText);
  }
};
