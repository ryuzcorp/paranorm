import { parseYAML } from "confbox";

import type {
  AccessAction,
  AccessDefinition,
  AccessPolicy,
  AuthoredSchema,
  ColumnDefinition,
  ColumnKind,
  RelationDefinition,
  SchemaMacroRegistry,
  TableDefinition,
} from "./types.ts";

const ACTIONS: AccessAction[] = ["list", "create", "update", "delete"];
const POLICIES = new Set<AccessPolicy>(["public", "authenticated", "owner"]);
const TYPE_PATTERN =
  /^(id(?:\((varchar\(\d+\)|bigint|uuidv4)\))?|decimal\((\d+)\s*,\s*(\d+)\)|string|int|bigint|boolean|timestamp|date|json|binary)(\?)?$/;

function fail(message: string): never {
  throw new Error(`Invalid schema: ${message}`);
}
function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${at} must be a mapping`);
  return value as Record<string, unknown>;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "",
    quote = "",
    parens = 0,
    brackets = 0;
  for (const char of input.trim()) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") parens++;
    else if (char === ")") parens--;
    if (char === "[") brackets++;
    else if (char === "]") brackets--;
    if (/\s/.test(char) && parens === 0 && brackets === 0) {
      if (current) tokens.push(current);
      current = "";
    } else current += char;
  }
  if (quote || parens !== 0 || brackets !== 0) fail(`unbalanced column definition '${input}'`);
  if (current) tokens.push(current);
  return tokens;
}

function parseDefault(raw: string): NonNullable<ColumnDefinition["default"]> {
  const sqlMatch = /^sql\((["'])([\s\S]*)\1\)$/.exec(raw);
  if (sqlMatch) return { kind: "sql", value: sqlMatch[2]! };
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    return { kind: "literal", value: raw.slice(1, -1) };
  if (raw === "true" || raw === "false") return { kind: "literal", value: raw === "true" };
  if (/^-?\d+(\.\d+)?$/.test(raw)) return { kind: "literal", value: Number(raw) };
  return { kind: "keyword", value: raw };
}

export function parseColumn(name: string, source: unknown): ColumnDefinition {
  if (typeof source !== "string") fail(`column '${name}' must be a string`);
  const tokens = tokenize(source);
  const first = tokens.shift() ?? "";
  const inferredReference = first.startsWith("references=");
  if (inferredReference) tokens.unshift(first);
  const type = inferredReference ? TYPE_PATTERN.exec("string")! : TYPE_PATTERN.exec(first);
  if (!type) fail(`column '${name}' has unsupported type in '${source}'`);
  let kind: ColumnKind, dataType: string, generation: ColumnDefinition["generation"];
  const rawType = type[1]!;
  if (rawType.startsWith("id")) {
    kind = "id";
    const parameter = type[2];
    if (!parameter) {
      dataType = "varchar(255)";
      generation = "cuid";
    } else if (parameter === "uuidv4") {
      dataType = "uuid";
      generation = "uuidv4";
    } else if (parameter === "bigint") {
      dataType = "bigint";
      generation = "auto-increment";
    } else {
      dataType = parameter;
      generation = "cuid";
    }
  } else if (rawType.startsWith("decimal")) {
    kind = "decimal";
    dataType = `decimal(${type[3]},${type[4]})`;
  } else {
    kind = rawType as ColumnKind;
    dataType = (
      {
        string: "varchar(255)",
        int: "integer",
        bigint: "bigint",
        boolean: "boolean",
        timestamp: "timestamp",
        date: "date",
        json: "json",
        binary: "blob",
      } as Record<string, string>
    )[kind]!;
  }
  const column: ColumnDefinition = {
    name,
    kind,
    dataType,
    nullable: Boolean(type[5]),
    primaryKey: kind === "id",
    ...(generation !== undefined ? { generation } : {}),
    unique: false,
    index: false,
    source,
  };
  for (const token of tokens) {
    const separator = token.indexOf("=");
    const key = separator < 0 ? token : token.slice(0, separator);
    const value = separator < 0 ? undefined : token.slice(separator + 1);
    if (key === "unique" && value === undefined) column.unique = true;
    else if (key === "index" && value === undefined) column.index = true;
    else if (key === "multiple" && value === undefined) column.multiple = true;
    else if (key === "enum" && value?.startsWith("[") && value.endsWith("]")) {
      column.enumValues = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (!column.enumValues.length) fail(`column '${name}' enum must not be empty`);
    } else if (key === "unique" && value?.startsWith("[") && value.endsWith("]")) {
      column.compositeUnique = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (column.compositeUnique.length < 2)
        fail(`column '${name}' composite unique needs at least two columns`);
    } else if (key === "default" && value !== undefined) column.default = parseDefault(value);
    else if (key === "references" && value !== undefined) {
      const match = /^([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)$/.exec(value);
      if (!match) fail(`column '${name}' has invalid reference '${value}'`);
      column.references = { table: match[1]!, column: match[2]! };
    } else if ((key === "on_delete" || key === "on_update") && value !== undefined) {
      if (!column.references) fail(`column '${name}' ${key} must follow references`);
      const action = value.replaceAll("_", " ");
      if (!["cascade", "set null", "restrict", "no action"].includes(action))
        fail(`column '${name}' has invalid ${key} action '${value}'`);
      if (key === "on_delete")
        column.references.onDelete = action as import("./types.ts").ReferentialAction;
      else column.references.onUpdate = action as import("./types.ts").ReferentialAction;
    } else fail(`column '${name}' has unsupported modifier '${token}'`);
  }
  return column;
}

function parseAccess(raw: unknown, table: TableDefinition): AccessDefinition {
  const value = object(raw, `${table.name}._access`);
  const access = Object.fromEntries(
    ACTIONS.map((action) => [action, "public"]),
  ) as unknown as AccessDefinition;
  for (const action of ACTIONS) {
    const policy = value[action];
    if (policy !== undefined) {
      if (!POLICIES.has(policy as AccessPolicy))
        fail(`${table.name}._access.${action} has invalid policy '${String(policy)}'`);
      access[action] = policy as AccessPolicy;
    }
  }
  if (value.owner_column !== undefined) {
    if (typeof value.owner_column !== "string" || !table.columns[value.owner_column])
      fail(`${table.name}._access.owner_column must name an existing column`);
    access.ownerColumn = value.owner_column;
  }
  if (ACTIONS.some((action) => access[action] === "owner") && !access.ownerColumn)
    fail(`${table.name}._access requires owner_column for owner policy`);
  for (const key of Object.keys(value))
    if (key !== "owner_column" && !ACTIONS.includes(key as AccessAction))
      fail(`${table.name}._access has unknown key '${key}'`);
  return access;
}

function authMacro(config: unknown): Record<string, unknown> {
  const options = config === undefined ? {} : object(config, "_auth");
  const roles = options.roles;
  if (
    roles !== undefined &&
    (!Array.isArray(roles) || roles.some((role) => typeof role !== "string" || role.includes(",")))
  )
    fail("_auth.roles must be an array of role names without commas");
  const roleModifier =
    Array.isArray(roles) && roles.length ? ` enum=[${roles.join(",")}] multiple` : "";
  const tables: Record<string, unknown> = {
    user: {
      id: "id",
      name: "string",
      email: "string unique",
      emailVerified: "boolean default=false",
      image: "string?",
      role: `string default="user"${roleModifier}`,
      banned: "boolean default=false",
      banReason: "string?",
      banExpires: "timestamp?",
      createdAt: "timestamp default=now",
      updatedAt: "timestamp default=now",
      _relations: {
        sessions: "has_many=session",
        accounts: "has_many=account",
      },
    },
    session: {
      id: "id",
      expiresAt: "timestamp",
      token: "string unique",
      ipAddress: "string?",
      userAgent: "string?",
      userId: "references=user.id on_delete=cascade index",
      impersonatedBy: "string?",
      createdAt: "timestamp default=now",
      updatedAt: "timestamp default=now",
      _relations: { user: "belongs_to=user" },
    },
    account: {
      id: "id",
      accountId: "string",
      providerId: "string",
      userId: "references=user.id on_delete=cascade index",
      accessToken: "string?",
      refreshToken: "string?",
      idToken: "string?",
      accessTokenExpiresAt: "timestamp?",
      refreshTokenExpiresAt: "timestamp?",
      scope: "string?",
      password: "string?",
      createdAt: "timestamp default=now",
      updatedAt: "timestamp default=now",
      _relations: { user: "belongs_to=user" },
    },
    verification: {
      id: "id",
      identifier: "string",
      value: "string",
      expiresAt: "timestamp",
      createdAt: "timestamp default=now",
      updatedAt: "timestamp default=now",
    },
  };
  if (options.api_keys === true)
    tables.apikey = {
      id: "id",
      configId: 'string default="default" index',
      name: "string?",
      start: "string?",
      prefix: "string?",
      key: "string index",
      referenceId: "references=user.id on_delete=cascade index",
      refillInterval: "int?",
      refillAmount: "int?",
      lastRefillAt: "timestamp?",
      enabled: "boolean default=true",
      rateLimitEnabled: "boolean default=true",
      rateLimitTimeWindow: "int?",
      rateLimitMax: "int?",
      requestCount: "int default=0",
      remaining: "int?",
      lastRequest: "timestamp?",
      expiresAt: "timestamp?",
      permissions: "string?",
      metadata: "string?",
      createdAt: "timestamp default=now",
      updatedAt: "timestamp default=now",
      _relations: { user: "belongs_to=user" },
    };
  return tables;
}

function filesMacro(config: unknown): Record<string, unknown> {
  const options = object(config, "_files");
  const attachTo = options.attach_to ?? [];
  if (!Array.isArray(attachTo) || attachTo.some((table) => typeof table !== "string"))
    fail("_files.attach_to must be an array of table names");
  if (options.owner !== undefined && typeof options.owner !== "boolean")
    fail("_files.owner must be a boolean");
  const owned = options.owner !== false;
  const file: Record<string, unknown> = {
    id: "id",
    key: "string unique",
    name: "string",
    type: "string",
    size: "int",
    createdAt: "timestamp default=now",
    updatedAt: "timestamp default=now",
  };
  if (owned) {
    file.userId = "references=user.id on_delete=set_null index";
    file._relations = { user: "belongs_to=user" };
  }
  const tables: Record<string, unknown> = { file };
  for (const entity of attachTo as string[])
    tables[`${entity}_file`] = {
      id: "id",
      fileId: "references=file.id on_delete=cascade index",
      entityId: `references=${entity}.id on_delete=cascade index`,
      role: "string?",
      position: "int default=0",
      createdAt: "timestamp default=now",
      updatedAt: "timestamp default=now",
      _relations: { file: "belongs_to=file", entity: `belongs_to=${entity}` },
    };
  return tables;
}

export const builtinMacros: SchemaMacroRegistry = {
  auth: ({ config }) => authMacro(config),
  files: ({ config }) => filesMacro(config),
};

function parseSchemaDocument(
  input: string | Record<string, unknown>,
  options: { macros?: SchemaMacroRegistry } = {},
): AuthoredSchema {
  const document = object(typeof input === "string" ? parseYAML(input) : input, "document");
  if (
    typeof document._version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(document._version)
  )
    fail("_version must be a semver string");
  const extensions = document._extends === undefined ? [] : document._extends;
  if (!Array.isArray(extensions) || extensions.some((item) => typeof item !== "string"))
    fail("_extends must be an array of macro names");
  const macros = { ...builtinMacros, ...options.macros };
  const expanded: Record<string, unknown> = {};
  for (const name of extensions as string[]) {
    const macro = macros[name];
    if (!macro) fail(`unknown extension '${name}'`);
    const config = document[`_${name}`];
    if (name === "files" && config === undefined) fail("files extension requires _files config");
    Object.assign(expanded, macro({ config }));
  }
  for (const [key, value] of Object.entries(document))
    if (!key.startsWith("_")) {
      if (expanded[key]) fail(`table '${key}' is supplied by an extension and cannot be redefined`);
      expanded[key] = value;
    }
  const tables: Record<string, TableDefinition> = {};
  for (const [name, raw] of Object.entries(expanded)) {
    const value = object(raw, name),
      columns: TableDefinition["columns"] = {};
    for (const [columnName, definition] of Object.entries(value))
      if (!columnName.startsWith("_")) columns[columnName] = parseColumn(columnName, definition);
    const table: TableDefinition = {
      name,
      columns,
      relations: {},
      uniqueConstraints: [],
    };
    for (const column of Object.values(columns)) {
      if (column.unique) table.uniqueConstraints.push([column.name]);
      if (column.compositeUnique) {
        const local = column.compositeUnique.map((qualified) => {
          const [owner, field] = qualified.split(".");
          if (owner !== name || !field || !columns[field])
            fail(`${name}.${column.name} has invalid composite unique member '${qualified}'`);
          return field;
        });
        if (!local.includes(column.name))
          fail(`${name}.${column.name} composite unique must include itself`);
        if (!table.uniqueConstraints.some((constraint) => constraint.join("|") === local.join("|")))
          table.uniqueConstraints.push(local);
      }
    }
    tables[name] = table;
  }
  for (const [name, raw] of Object.entries(expanded)) {
    const value = object(raw, name),
      table = tables[name]!;
    if (value._relations !== undefined)
      for (const [relationName, definition] of Object.entries(
        object(value._relations, `${name}._relations`),
      )) {
        if (typeof definition !== "string")
          fail(`${name}._relations.${relationName} must be a string`);
        const match = /^(belongs_to|has_many)=([A-Za-z_][\w]*)$/.exec(definition);
        if (!match || !tables[match[2]!])
          fail(`${name}._relations.${relationName} is invalid or targets an unknown table`);
        const relation: RelationDefinition = {
          name: relationName,
          kind: match[1] as RelationDefinition["kind"],
          table: match[2]!,
        };
        if (relation.kind === "belongs_to") {
          const matches = Object.values(table.columns).filter(
            (column) => column.references?.table === relation.table,
          );
          if (matches.length !== 1)
            fail(
              `${name}._relations.${relationName} requires exactly one foreign key to '${relation.table}'`,
            );
          relation.column = matches[0]!.name;
        }
        table.relations[relationName] = relation;
      }
    if (value._access !== undefined) table.access = parseAccess(value._access, table);
  }
  for (const table of Object.values(tables))
    for (const column of Object.values(table.columns)) {
      if (column.references && !tables[column.references.table]?.columns[column.references.column])
        fail(
          `${table.name}.${column.name} references missing column '${column.references.table}.${column.references.column}'`,
        );
      if (column.references && column.source.trim().startsWith("references=")) {
        const target = tables[column.references.table]!.columns[column.references.column]!;
        column.kind = target.kind;
        column.dataType = target.dataType;
      }
    }
  for (const table of Object.values(tables))
    for (const relation of Object.values(table.relations))
      if (relation.kind === "has_many") {
        const reverse = Object.values(tables[relation.table]!.relations).some(
          (candidate) => candidate.kind === "belongs_to" && candidate.table === table.name,
        );
        if (!reverse)
          fail(
            `${table.name}._relations.${relation.name} has no reverse belongs_to on '${relation.table}'`,
          );
      }
  const pending = new Set(Object.keys(tables)),
    tableOrder: string[] = [];
  while (pending.size) {
    const ready = [...pending].filter((name) =>
      Object.values(tables[name]!.columns).every(
        (column) => !column.references || !pending.has(column.references.table),
      ),
    );
    if (!ready.length) fail(`foreign key cycle between: ${[...pending].join(", ")}`);
    for (const name of ready) {
      pending.delete(name);
      tableOrder.push(name);
    }
  }
  const extensionConfig = Object.fromEntries(
    Object.entries(document).filter(
      ([key]) => key.startsWith("_") && key !== "_version" && key !== "_extends",
    ),
  );
  return {
    version: document._version,
    extends: extensions as string[],
    extensions: extensionConfig,
    tables,
    tableOrder,
  };
}

export class SchemaValidationError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
    readonly sourceName = "schema",
    options?: ErrorOptions,
  ) {
    super(`${sourceName}:${line}:${column} ${message}`, options);
    this.name = "SchemaValidationError";
  }
}

function locateSchemaError(source: string, message: string): { line: number; column: number } {
  const stack: Array<{ indent: number; key: string }> = [];
  let best: { line: number; column: number; score: number } | undefined;
  for (const [index, line] of source.split("\n").entries()) {
    const match = /^(\s*)([A-Za-z_][\w]*):/.exec(line);
    if (!match) continue;
    const indent = match[1]!.replaceAll("\t", "  ").length;
    const key = match[2]!;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const path = [...stack.map((entry) => entry.key), key].join(".");
    const score = message.includes(path)
      ? path.length + 100
      : message.includes(key)
        ? key.length
        : -1;
    if (score > (best?.score ?? -1))
      best = { line: index + 1, column: match[1]!.length + 1, score };
    stack.push({ indent, key });
  }
  return best ?? { line: 1, column: 1 };
}

export function parseSchema(
  input: string | Record<string, unknown>,
  options: { macros?: SchemaMacroRegistry; sourceName?: string } = {},
): AuthoredSchema {
  if (typeof input !== "string") return parseSchemaDocument(input, options);
  try {
    return parseSchemaDocument(input, options);
  } catch (cause) {
    if (cause instanceof SchemaValidationError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    const location = locateSchemaError(input, message);
    throw new SchemaValidationError(message, location.line, location.column, options.sourceName, {
      cause,
    });
  }
}
