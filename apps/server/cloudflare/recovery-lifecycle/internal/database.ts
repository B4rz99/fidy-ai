import type { RecoveryLifecycleEnvironment } from "../contract";
import { RecoveryOperationUnavailable } from "../contract";
import { sql as native } from "./sql-settlement";

const statements = (
  environment: RecoveryLifecycleEnvironment
): Readonly<{
  prepare: (statement: D1PreparedStatement) => D1PreparedStatement;
  unwrap: (statement: D1PreparedStatement) => D1PreparedStatement;
}> => {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const unwrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    originals.get(statement) ?? statement;
  const prepare = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get: (target, property, receiver): unknown => {
        if (property === "bind") {
          return (...values: Array<unknown>): D1PreparedStatement =>
            prepare(target.bind(...values));
        }
        if (property === "first") {
          return (column?: string): Promise<unknown> =>
            native({
              environment,
              work: () => (column === undefined ? target.first() : target.first(column)),
            });
        }
        if (property === "all") {
          return (): Promise<D1Result> => native({ environment, work: () => target.all() });
        }
        if (property === "run") {
          return (): Promise<D1Result> => native({ environment, work: () => target.run() });
        }
        if (property === "raw") {
          return (options?: Readonly<{ columnNames: boolean }>): Promise<unknown> =>
            native({
              environment,
              work: () =>
                options?.columnNames === true
                  ? target.raw({ columnNames: true })
                  : target.raw({ columnNames: false }),
            });
        }
        return Reflect.get(target, property, receiver);
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  return { prepare, unwrap };
};

export const database = ({
  binding,
  environment,
}: Readonly<{
  binding: D1Database;
  environment: RecoveryLifecycleEnvironment;
}>): D1Database => {
  if (
    environment.RECOVERY_ADMISSION === undefined &&
    environment.RECOVERY_SOURCE_EPOCH === undefined
  ) {
    return binding;
  }
  const { prepare, unwrap } = statements(environment);
  const session = (value: D1DatabaseSession): D1DatabaseSession => ({
    prepare: (sql) => prepare(value.prepare(sql)),
    batch: <Row>(statements: Array<D1PreparedStatement>): Promise<Array<D1Result<Row>>> =>
      native({ environment, work: () => value.batch<Row>(statements.map(unwrap)) }),
    getBookmark: () => value.getBookmark(),
  });
  return {
    prepare: (sql) => prepare(binding.prepare(sql)),
    batch: <Row>(statements: Array<D1PreparedStatement>): Promise<Array<D1Result<Row>>> =>
      native({ environment, work: () => binding.batch<Row>(statements.map(unwrap)) }),
    exec: (sql) => native({ environment, work: () => binding.exec(sql) }),
    withSession: (bookmark) => session(binding.withSession(bookmark)),
    dump: () => Promise.reject(new RecoveryOperationUnavailable()),
  };
};
