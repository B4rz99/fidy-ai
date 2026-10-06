import { Option, Predicate } from "effect";

type CommitGate = Readonly<{
  waiting: ReturnType<typeof Promise.withResolvers<void>>;
  release: ReturnType<typeof Promise.withResolvers<void>>;
  settled: ReturnType<typeof Promise.withResolvers<void>>;
}>;
type StatementSource = Readonly<{ statement: D1PreparedStatement; sql: string }>;

const trackStatement = (
  source: StatementSource,
  sources: WeakMap<D1PreparedStatement, StatementSource>
): D1PreparedStatement => {
  const tracked = new Proxy(source.statement, {
    get: (target, key): unknown => {
      if (key === "bind") {
        return (...values: unknown[]): D1PreparedStatement =>
          trackStatement({ statement: target.bind(...values), sql: source.sql }, sources);
      }
      const member: unknown = Reflect.get(target, key);
      return Predicate.isFunction(member) ? member.bind(target) : member;
    },
  });
  sources.set(tracked, source);
  return tracked;
};

/** Hold one protected native mutation batch after preparation, before D1 executes any statement. */
export const makeMutationCommitGate = (
  database: D1Database
): Readonly<{
  db: D1Database;
  hold: () => Readonly<{ waiting: Promise<void>; settled: Promise<void>; release: () => void }>;
}> => {
  let gate: Option.Option<CommitGate> = Option.none();
  const sources = new WeakMap<D1PreparedStatement, StatementSource>();
  const batch = <Result>(statements: D1PreparedStatement[]): Promise<D1Result<Result>[]> => {
    const run = (): Promise<D1Result<Result>[]> =>
      database.batch<Result>(
        statements.map((statement) => sources.get(statement)?.statement ?? statement)
      );
    const held = gate;
    const protectedMutation = statements.some((statement) => {
      const sql = sources.get(statement)?.sql ?? "";
      return (
        sql.includes("INSERT INTO transactions (") ||
        sql.includes("DELETE FROM oauth_operation_intents WHERE reference = ?")
      );
    });
    if (Option.isNone(held) || !protectedMutation) return run();
    gate = Option.none();
    held.value.waiting.resolve();
    return held.value.release.promise.then(run).finally(held.value.settled.resolve);
  };
  const db = new Proxy(database, {
    get: (target, key): unknown => {
      if (key === "prepare") {
        return (sql: string): D1PreparedStatement =>
          trackStatement({ statement: target.prepare(sql), sql }, sources);
      }
      if (key === "batch") return batch;
      const member: unknown = Reflect.get(target, key);
      return Predicate.isFunction(member) ? member.bind(target) : member;
    },
  });
  return {
    db,
    hold: () => {
      const held: CommitGate = {
        waiting: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
        settled: Promise.withResolvers<void>(),
      };
      gate = Option.some(held);
      return {
        waiting: held.waiting.promise,
        settled: held.settled.promise,
        release: held.release.resolve,
      };
    },
  };
};
