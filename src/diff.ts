import type {
  AuthoredSchema,
  ColumnDefinition,
  DefaultValue,
  Reference,
  SchemaDiff,
  TableDefinition,
} from "./types.ts";

interface StableObject {
  [key: string]: StableValue;
}
type StableValue =
  | string
  | number
  | boolean
  | null
  | StableValue[]
  | StableObject
  | ColumnDefinition
  | DefaultValue
  | Reference;

const stable = (value: StableValue): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  if (Object(value) === value) {
    // SAFETY: non-array objects entering this branch are stable serializable records.
    const entries = Object.entries(value as StableObject);
    return `{${entries
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const constraintKey = (columns: string[]): string => columns.join("\u0000");

const collectAddedTables = (
  to: AuthoredSchema,
  previous: Record<string, TableDefinition>
): TableDefinition[] => {
  const added: TableDefinition[] = [];
  for (const name of to.tableOrder) {
    if (!previous[name]) {
      const table = to.tables[name];
      if (table) {
        added.push(table);
      }
    }
  }
  return added;
};

const collectRemovedTables = (
  from: AuthoredSchema,
  to: AuthoredSchema
): TableDefinition[] => {
  const removed: TableDefinition[] = [];
  for (const name of from.tableOrder.toReversed()) {
    if (!to.tables[name]) {
      const table = from.tables[name];
      if (table) {
        removed.push(table);
      }
    }
  }
  return removed;
};

const diffColumnIndexes = (
  name: string,
  old: ColumnDefinition,
  column: ColumnDefinition,
  diff: SchemaDiff
): void => {
  if (!old.index && column.index) {
    diff.addedIndexes.push({ column: column.name, table: name });
  }
  if (old.index && !column.index) {
    diff.removedIndexes.push({ column: column.name, table: name });
  }
};

const diffTableColumns = (
  name: string,
  prior: TableDefinition,
  next: TableDefinition,
  diff: SchemaDiff
): void => {
  for (const column of Object.values(next.columns)) {
    const old = prior.columns[column.name];
    if (old) {
      if (stable(old) !== stable(column)) {
        diff.changedColumns.push({ from: old, table: name, to: column });
      }
      diffColumnIndexes(name, old, column, diff);
    } else {
      diff.addedColumns.push({ column, table: name });
    }
  }
  for (const column of Object.values(prior.columns)) {
    if (!next.columns[column.name]) {
      if (column.index) {
        diff.removedIndexes.push({ column: column.name, table: name });
      }
      diff.removedColumns.push({ column, table: name });
    }
  }
};

const diffTableConstraints = (
  name: string,
  prior: TableDefinition,
  next: TableDefinition,
  diff: SchemaDiff
): void => {
  const oldConstraints = new Map(
    prior.uniqueConstraints.map((columns) => [constraintKey(columns), columns])
  );
  const newConstraints = new Map(
    next.uniqueConstraints.map((columns) => [constraintKey(columns), columns])
  );
  for (const [key, columns] of newConstraints) {
    if (!oldConstraints.has(key)) {
      diff.addedUniqueConstraints.push({ columns, table: name });
    }
  }
  for (const [key, columns] of oldConstraints) {
    if (!newConstraints.has(key)) {
      diff.removedUniqueConstraints.push({ columns, table: name });
    }
  }
};

export const diffSchemas = (
  from: AuthoredSchema | undefined,
  to: AuthoredSchema
): SchemaDiff => {
  const diff: SchemaDiff = {
    addedColumns: [],
    addedIndexes: [],
    addedTables: [],
    addedUniqueConstraints: [],
    changedColumns: [],
    removedColumns: [],
    removedIndexes: [],
    removedTables: [],
    removedUniqueConstraints: [],
    toVersion: to.version,
  };
  if (from) {
    diff.fromVersion = from.version;
  }
  const previous = from?.tables ?? {};
  diff.addedTables.push(...collectAddedTables(to, previous));
  if (from) {
    diff.removedTables.push(...collectRemovedTables(from, to));
  }
  for (const [name, next] of Object.entries(to.tables)) {
    const prior = previous[name];
    if (!prior) {
      continue;
    }
    diffTableColumns(name, prior, next, diff);
    diffTableConstraints(name, prior, next, diff);
  }
  return diff;
};

export const columnChanged = (
  from: ColumnDefinition,
  to: ColumnDefinition
): boolean => stable(from) !== stable(to);

export const isDestructiveDiff = (diff: SchemaDiff): boolean =>
  diff.removedTables.length > 0 ||
  diff.removedColumns.length > 0 ||
  diff.changedColumns.length > 0 ||
  diff.removedUniqueConstraints.length > 0;
