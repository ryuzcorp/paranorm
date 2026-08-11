import type { AuthoredSchema, ColumnDefinition, SchemaDiff } from "./types.ts";

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const constraintKey = (columns: string[]) => columns.join("\u0000");

export function diffSchemas(from: AuthoredSchema | undefined, to: AuthoredSchema): SchemaDiff {
  const diff: SchemaDiff = {
    ...(from ? { fromVersion: from.version } : {}),
    toVersion: to.version,
    addedTables: [],
    removedTables: [],
    addedColumns: [],
    removedColumns: [],
    changedColumns: [],
    addedUniqueConstraints: [],
    removedUniqueConstraints: [],
    addedIndexes: [],
    removedIndexes: [],
  };
  const previous = from?.tables ?? {};
  for (const name of to.tableOrder) if (!previous[name]) diff.addedTables.push(to.tables[name]!);
  if (from)
    for (const name of from.tableOrder.toReversed())
      if (!to.tables[name]) diff.removedTables.push(from.tables[name]!);
  for (const [name, next] of Object.entries(to.tables)) {
    const prior = previous[name];
    if (!prior) continue;
    for (const column of Object.values(next.columns)) {
      const old = prior.columns[column.name];
      if (!old) diff.addedColumns.push({ table: name, column });
      else {
        if (stable(old) !== stable(column))
          diff.changedColumns.push({ table: name, from: old, to: column });
        if (!old.index && column.index)
          diff.addedIndexes.push({ table: name, column: column.name });
        if (old.index && !column.index)
          diff.removedIndexes.push({ table: name, column: column.name });
      }
    }
    for (const column of Object.values(prior.columns))
      if (!next.columns[column.name]) {
        if (column.index) diff.removedIndexes.push({ table: name, column: column.name });
        diff.removedColumns.push({ table: name, column });
      }
    const oldConstraints = new Map(
      prior.uniqueConstraints.map((columns) => [constraintKey(columns), columns]),
    );
    const newConstraints = new Map(
      next.uniqueConstraints.map((columns) => [constraintKey(columns), columns]),
    );
    for (const [key, columns] of newConstraints)
      if (!oldConstraints.has(key)) diff.addedUniqueConstraints.push({ table: name, columns });
    for (const [key, columns] of oldConstraints)
      if (!newConstraints.has(key)) diff.removedUniqueConstraints.push({ table: name, columns });
  }
  return diff;
}

export function columnChanged(from: ColumnDefinition, to: ColumnDefinition): boolean {
  return stable(from) !== stable(to);
}
export function isDestructiveDiff(diff: SchemaDiff): boolean {
  return (
    diff.removedTables.length > 0 ||
    diff.removedColumns.length > 0 ||
    diff.changedColumns.length > 0 ||
    diff.removedUniqueConstraints.length > 0
  );
}
