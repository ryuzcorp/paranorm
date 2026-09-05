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
const YAML_KEY_PATTERN = /^(?<indent>\s*)(?<key>[A-Za-z_][\w]*):/u;
const WHITESPACE_PATTERN = /\s/u;

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

interface ParseSchemaOptions {
  macros?: SchemaMacroRegistry;
  sourceName?: string;
}

const fail = (message: string): never => {
  throw new Error(`Invalid schema: ${message}`);
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
    return fail(`${at} must be a mapping`);
  }
  return value;
};

const expectYamlString = (value: YamlValue, at: string): string => {
  if (String(value) !== value) {
    return fail(`${at} must be a string`);
  }
  return value;
};

const expectYamlStringArray = (value: YamlValue, at: string): string[] => {
  if (!Array.isArray(value)) {
    return fail(`${at} must be an array`);
  }
  return value.map((item: YamlValue, index: number) =>
    expectYamlString(item, `${at}[${index}]`)
  );
};

const expectYamlBoolean = (value: YamlValue, at: string): boolean => {
  if (value !== true && value !== false) {
    return fail(`${at} must be a boolean`);
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

const tokenize = (input: string): string[] => {
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
    fail(`unbalanced column definition '${input}'`);
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
  name: string
): Pick<ColumnDefinition, "dataType" | "generation" | "kind" | "nullable"> => {
  const nullable = Boolean(groups.nullable);
  if (groups.rawType.startsWith("id")) {
    return { ...resolveIdColumn(groups), nullable };
  }
  if (groups.rawType.startsWith("decimal")) {
    const { precision, scale } = groups;
    if (!precision || !scale) {
      fail(`column '${name}' has invalid decimal type`);
    }
    return {
      dataType: `decimal(${precision},${scale})`,
      kind: "decimal",
      nullable,
    };
  }
  if (!isColumnKind(groups.rawType)) {
    return fail(`column '${name}' has unsupported type '${groups.rawType}'`);
  }
  const kind = groups.rawType;
  const dataType = COLUMN_DATA_TYPES[kind];
  if (!dataType) {
    return fail(`column '${name}' has unsupported type '${kind}'`);
  }
  return { dataType, kind, nullable };
};

const applyReferentialAction = (
  column: ColumnDefinition,
  key: string,
  value: string,
  name: string
): void => {
  if (!column.references) {
    return fail(`column '${name}' ${key} must follow references`);
  }
  const action = value.replaceAll("_", " ");
  if (!isReferentialAction(action)) {
    return fail(`column '${name}' has invalid ${key} action '${value}'`);
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
  name: string
): void => {
  column.enumValues = value
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!column.enumValues.length) {
    fail(`column '${name}' enum must not be empty`);
  }
};

const applyCompositeUniqueToken = (
  column: ColumnDefinition,
  value: string,
  name: string
): void => {
  column.compositeUnique = value
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (column.compositeUnique.length < 2) {
    fail(`column '${name}' composite unique needs at least two columns`);
  }
};

const applyReferencesToken = (
  column: ColumnDefinition,
  value: string,
  name: string
): void => {
  const match = REFERENCE_PATTERN.exec(value);
  const table = match?.groups?.table;
  const refColumn = match?.groups?.column;
  if (!table || !refColumn) {
    return fail(`column '${name}' has invalid reference '${value}'`);
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
  name: string
): boolean => {
  if (key === "enum" && value.startsWith("[") && value.endsWith("]")) {
    applyEnumToken(column, value, name);
    return true;
  }
  if (key === "unique" && value.startsWith("[") && value.endsWith("]")) {
    applyCompositeUniqueToken(column, value, name);
    return true;
  }
  if (key === "default") {
    column.default = parseDefault(value);
    return true;
  }
  if (key === "references") {
    applyReferencesToken(column, value, name);
    return true;
  }
  if (key === "on_delete" || key === "on_update") {
    applyReferentialAction(column, key, value, name);
    return true;
  }
  return false;
};

const applyColumnToken = (
  column: ColumnDefinition,
  token: string,
  name: string
): void => {
  const separator = token.indexOf("=");
  const key = separator === -1 ? token : token.slice(0, separator);
  const value = separator === -1 ? undefined : token.slice(separator + 1);
  if (applyFlagToken(column, key, value)) {
    return;
  }
  if (value !== undefined && applyValueToken(column, key, value, name)) {
    return;
  }
  fail(`column '${name}' has unsupported modifier '${token}'`);
};

export const parseColumn = (
  name: string,
  source: YamlValue
): ColumnDefinition => {
  const sourceText = expectYamlString(source, `column '${name}'`);
  const tokens = tokenize(sourceText);
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
    return fail(`column '${name}' has unsupported type in '${sourceText}'`);
  }
  const resolved = resolveColumnType(groups, name);
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
    applyColumnToken(column, token, name);
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
  const value = expectYamlMapping(raw, `${table.name}._access`);
  const access = defaultAccessDefinition();
  for (const action of ACTIONS) {
    const policy = value[action];
    if (policy !== undefined) {
      if (!isAccessPolicy(policy)) {
        return fail(
          `${table.name}._access.${action} has invalid policy '${String(policy)}'`
        );
      }
      access[action] = policy;
    }
  }
  if (value.owner_column !== undefined) {
    const ownerColumn = expectYamlString(
      value.owner_column,
      `${table.name}._access.owner_column`
    );
    if (!table.columns[ownerColumn]) {
      fail(`${table.name}._access.owner_column must name an existing column`);
    }
    access.ownerColumn = ownerColumn;
  }
  if (
    ACTIONS.some((action) => access[action] === "owner") &&
    !access.ownerColumn
  ) {
    fail(`${table.name}._access requires owner_column for owner policy`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "owner_column" && !isAccessAction(key)) {
      fail(`${table.name}._access has unknown key '${key}'`);
    }
  }
  return access;
};

const authMacro = (config: YamlValue) => {
  const options = config === null ? {} : expectYamlMapping(config, "_auth");
  const { roles } = options;
  if (roles !== undefined) {
    const roleList = expectYamlStringArray(roles, "_auth.roles");
    if (roleList.some((role) => role.includes(","))) {
      fail("_auth.roles must be an array of role names without commas");
    }
  }
  const roleNames = Array.isArray(roles)
    ? roles.map((role, index) =>
        expectYamlString(role, `_auth.roles[${index}]`)
      )
    : [];
  const roleModifier =
    roleNames.length > 0 ? ` enum=[${roleNames.join(",")}] multiple` : "";
  const tables = {
    account: {
      _relations: { user: "belongs_to=user" },
      accessToken: "string?",
      accessTokenExpiresAt: "timestamp?",
      accountId: "string",
      createdAt: "timestamp default=now",
      id: "id",
      idToken: "string?",
      password: "string?",
      providerId: "string",
      refreshToken: "string?",
      refreshTokenExpiresAt: "timestamp?",
      scope: "string?",
      updatedAt: "timestamp default=now",
      userId: "references=user.id on_delete=cascade index",
    },
    session: {
      _relations: { user: "belongs_to=user" },
      createdAt: "timestamp default=now",
      expiresAt: "timestamp",
      id: "id",
      impersonatedBy: "string?",
      ipAddress: "string?",
      token: "string unique",
      updatedAt: "timestamp default=now",
      userAgent: "string?",
      userId: "references=user.id on_delete=cascade index",
    },
    user: {
      _relations: {
        accounts: "has_many=account",
        sessions: "has_many=session",
      },
      banExpires: "timestamp?",
      banReason: "string?",
      banned: "boolean default=false",
      createdAt: "timestamp default=now",
      email: "string unique",
      emailVerified: "boolean default=false",
      id: "id",
      image: "string?",
      name: "string",
      role: `string default="user"${roleModifier}`,
      updatedAt: "timestamp default=now",
    },
    verification: {
      createdAt: "timestamp default=now",
      expiresAt: "timestamp",
      id: "id",
      identifier: "string",
      updatedAt: "timestamp default=now",
      value: "string",
    },
  };
  if (options.api_keys === true) {
    return {
      ...tables,
      apikey: {
        _relations: { user: "belongs_to=user" },
        configId: 'string default="default" index',
        createdAt: "timestamp default=now",
        enabled: "boolean default=true",
        expiresAt: "timestamp?",
        id: "id",
        key: "string index",
        lastRefillAt: "timestamp?",
        lastRequest: "timestamp?",
        metadata: "string?",
        name: "string?",
        permissions: "string?",
        prefix: "string?",
        rateLimitEnabled: "boolean default=true",
        rateLimitMax: "int?",
        rateLimitTimeWindow: "int?",
        referenceId: "references=user.id on_delete=cascade index",
        refillAmount: "int?",
        refillInterval: "int?",
        remaining: "int?",
        requestCount: "int default=0",
        start: "string?",
        updatedAt: "timestamp default=now",
      },
    } satisfies Record<string, YamlValue>;
  }
  return tables satisfies Record<string, YamlValue>;
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

export const builtinMacros: SchemaMacroRegistry = {
  auth: ({ config }) => authMacro(config),
  files: ({ config }) => filesMacro(config),
};

const validateVersion = (document: SchemaDocument): string => {
  const version = document._version;
  if (version === undefined) {
    return fail("_version must be a semver string");
  }
  const versionText = expectYamlString(version, "_version");
  if (!SEMVER_PATTERN.test(versionText)) {
    fail("_version must be a semver string");
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
      return fail(`unknown extension '${name}'`);
    }
    const config = document[`_${name}`] ?? null;
    if (name === "files" && config === null) {
      return fail("files extension requires _files config");
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
        `table '${key}' is supplied by an extension and cannot be redefined`
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
    const local: string[] = column.compositeUnique.map((qualified) => {
      const [owner, field] = qualified.split(".");
      if (owner !== name || !field || !columns[field]) {
        return fail(
          `${name}.${column.name} has invalid composite unique member '${qualified}'`
        );
      }
      return field;
    });
    if (!local.includes(column.name)) {
      fail(`${name}.${column.name} composite unique must include itself`);
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
      columns[columnName] = parseColumn(columnName, definition);
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
  const relationSource = expectYamlString(
    definition,
    `${name}._relations.${relationName}`
  );
  const match = RELATION_PATTERN.exec(relationSource);
  const kindText = match?.groups?.kind;
  const targetTable = match?.groups?.table;
  if (!kindText || !targetTable || !tables[targetTable]) {
    return fail(
      `${name}._relations.${relationName} is invalid or targets an unknown table`
    );
  }
  if (!isRelationKind(kindText)) {
    return fail(`${name}._relations.${relationName} has invalid relation kind`);
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
  const matches = Object.values(table.columns).filter(
    (column) => column.references?.table === relation.table
  );
  if (matches.length !== 1) {
    fail(
      `${name}._relations.${relationName} requires exactly one foreign key to '${relation.table}'`
    );
  }
  const [match] = matches;
  if (!match) {
    return fail(
      `${name}._relations.${relationName} requires exactly one foreign key to '${relation.table}'`
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
      fail(`table '${name}' was not built`);
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
      const targetTable = tables[column.references.table];
      const targetColumn = targetTable?.columns[column.references.column];
      if (!targetTable || !targetColumn) {
        fail(
          `${table.name}.${column.name} references missing column '${column.references.table}.${column.references.column}'`
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
      const target = tables[relation.table];
      if (!target) {
        fail(
          `${table.name}._relations.${relation.name} targets unknown table '${relation.table}'`
        );
        continue;
      }
      const reverse = Object.values(target.relations).some(
        (candidate) =>
          candidate.kind === "belongs_to" && candidate.table === table.name
      );
      if (!reverse) {
        fail(
          `${table.name}._relations.${relation.name} has no reverse belongs_to on '${relation.table}'`
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

export class SchemaValidationError extends Error {
  readonly column: number;
  readonly line: number;
  readonly sourceName: string;

  constructor(
    message: string,
    line: number,
    column: number,
    sourceName = "schema",
    options?: ErrorOptions
  ) {
    super(`${sourceName}:${line}:${column} ${message}`, options);
    this.name = "SchemaValidationError";
    this.line = line;
    this.column = column;
    this.sourceName = sourceName;
  }
}

const locateSchemaError = (
  source: string,
  message: string
): { column: number; line: number } => {
  const stack: { indent: number; key: string }[] = [];
  let best: { column: number; line: number; score: number } | undefined;
  for (const [index, line] of source.split("\n").entries()) {
    const match = YAML_KEY_PATTERN.exec(line);
    const indentText = match?.groups?.indent;
    const key = match?.groups?.key;
    if (!indentText || !key) {
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
    const path = [...stack.map((entry) => entry.key), key].join(".");
    let score = -1;
    if (message.includes(path)) {
      score = path.length + 100;
    } else if (message.includes(key)) {
      score = key.length;
    }
    if (score > (best?.score ?? -1)) {
      best = { column: indentText.length + 1, line: index + 1, score };
    }
    stack.push({ indent, key });
  }
  return best ?? { column: 1, line: 1 };
};

export const parseSchema = (
  input: string | SchemaDocument,
  options: ParseSchemaOptions = {}
): AuthoredSchema => {
  if (isYamlMapping(input)) {
    return parseSchemaDocument(input, options);
  }
  try {
    return parseSchemaDocument(input, options);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const location = locateSchemaError(input, message);
    throw new SchemaValidationError(
      message,
      location.line,
      location.column,
      options.sourceName,
      { cause: error }
    );
  }
};
