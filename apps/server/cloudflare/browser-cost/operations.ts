/** Counts local D1 work across the request binding and its sessions without retaining SQL or values. */
export const observeBrowserCost = (
  database: D1Database
): Readonly<{
  database: D1Database;
  cost: () => Readonly<{ rowsRead: number; rowsWritten: number }>;
}> => {
  let rowsRead = 0;
  let rowsWritten = 0;
  const nativeStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const record = <Row>(result: D1Result<Row>): D1Result<Row> => {
    rowsRead += result.meta.rows_read;
    rowsWritten += result.meta.rows_written;
    return result;
  };
  const statement = (native: D1PreparedStatement): D1PreparedStatement => {
    const observed = new Proxy(native, {
      get(target, property): unknown {
        if (property === "bind") {
          return (...values: Parameters<D1PreparedStatement["bind"]>) =>
            statement(target.bind(...values));
        }
        if (property === "all" || property === "run") {
          return () => target[property]().then(record);
        }
        if (property === "first") {
          return (column?: string) =>
            target.all().then((result) => firstValue(record(result), column));
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    nativeStatements.set(observed, native);
    return observed;
  };
  const binding = <Binding extends D1Database | D1DatabaseSession>(native: Binding): Binding =>
    new Proxy(native, {
      get(target, property): unknown {
        if (property === "prepare") return (sql: string) => statement(target.prepare(sql));
        if (property === "batch") {
          return (statements: D1PreparedStatement[]) =>
            target
              .batch(statements.map((prepared) => nativeStatements.get(prepared) ?? prepared))
              .then((results) => results.map(record));
        }
        if (property === "withSession") {
          return (bookmark?: Parameters<D1Database["withSession"]>[0]) =>
            binding(database.withSession(bookmark));
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return { database: binding(database), cost: () => ({ rowsRead, rowsWritten }) };
};
const firstValue = (result: D1Result<Record<string, unknown>>, column?: string): unknown => {
  const row = result.results[0];
  if (row === undefined) return null;
  if (column === undefined) return row;
  if (row[column] === undefined) throw new Error("D1_COLUMN_NOTFOUND");
  return row[column];
};
