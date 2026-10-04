import { Data, Effect } from "effect";
import { currentMillis } from "../../runtime/operations";
import { transactionUnavailable } from "../../canonical-work/operations";

class QueryLifetimeExpired extends Data.TaggedError("QueryLifetimeExpired") {}
type Lifetime = Readonly<{ signal: AbortSignal; deadlineMilliseconds: number }>;
type Schedule = <A>(run: () => Promise<A>) => Promise<A>;
type Statements = WeakMap<D1PreparedStatement, D1PreparedStatement>;

const fencedStatement = (
  statement: D1PreparedStatement,
  schedule: Schedule,
  originals: Statements
): D1PreparedStatement => {
  const fenced = new Proxy(statement, {
    get: (target, key): unknown => {
      if (key === "bind") {
        return (...values: unknown[]): D1PreparedStatement =>
          fencedStatement(target.bind(...values), schedule, originals);
      }
      if (key === "first") {
        return (column?: string): Promise<unknown> =>
          schedule(() => (column === undefined ? target.first() : target.first(column)));
      }
      if (key === "all") return (): Promise<D1Result> => schedule(() => target.all());
      if (key === "run") return (): Promise<D1Result> => schedule(() => target.run());
      if (key === "raw") {
        return (
          options?: Parameters<D1PreparedStatement["raw"]>[0] | Readonly<{ columnNames: true }>
        ): Promise<unknown[]> =>
          schedule(() =>
            options?.columnNames === true
              ? target.raw({ columnNames: true })
              : target.raw({ columnNames: false })
          );
      }
      return Reflect.get(target, key);
    },
  });
  originals.set(fenced, statement);
  return fenced;
};
const fencedSession = (
  source: Pick<D1DatabaseSession, "prepare" | "batch">,
  schedule: Schedule,
  originals: Statements
): Pick<D1DatabaseSession, "prepare" | "batch"> => ({
  prepare: (query: string): D1PreparedStatement =>
    fencedStatement(source.prepare(query), schedule, originals),
  batch: <Result>(statements: D1PreparedStatement[]): Promise<D1Result<Result>[]> =>
    schedule(() =>
      source.batch<Result>(statements.map((statement) => originals.get(statement) ?? statement))
    ),
});

/** D1 cannot abort an atomic unit. Fence new units and retain the coordination turn until started units settle. */
const queryDatabase = (
  database: D1Database,
  lifetime: Lifetime
): Readonly<{ db: D1Database; close: () => Promise<void> }> => {
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const originals: Statements = new WeakMap();
  const schedule: Schedule = (run) => {
    if (closed || lifetime.signal.aborted || currentMillis() >= lifetime.deadlineMilliseconds) {
      throw new QueryLifetimeExpired();
    }
    const unit = run();
    pending.add(unit);
    unit.then(
      () => pending.delete(unit),
      () => pending.delete(unit)
    );
    return unit;
  };
  return {
    db: {
      ...fencedSession(database, schedule, originals),
      exec: (query: string): Promise<D1ExecResult> => schedule(() => database.exec(query)),
      dump: (): Promise<ArrayBuffer> => schedule(() => database.dump()),
      withSession: (bookmark?: D1SessionBookmark): D1DatabaseSession => {
        const session = database.withSession(bookmark);
        return {
          ...fencedSession(session, schedule, originals),
          getBookmark: (): ReturnType<D1DatabaseSession["getBookmark"]> => session.getBookmark(),
        };
      },
    },
    close: (): Promise<void> => {
      closed = true;
      return Promise.allSettled(pending).then(() => undefined);
    },
  };
};
const aborted = (signal: AbortSignal): Effect.Effect<never, QueryLifetimeExpired> =>
  Effect.callback((resume) => {
    const abort = (): void => resume(Effect.fail(new QueryLifetimeExpired()));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

/** Bound orchestration, including detached Promise owners, without abandoning an in-flight accounting unit. */
export const withQueryLifetime = (
  input: Lifetime &
    Readonly<{ db: D1Database; execute: (db: D1Database) => Effect.Effect<Response> }>
): Effect.Effect<Response> =>
  Effect.scoped(
    Effect.gen(function* () {
      const remaining = input.deadlineMilliseconds - currentMillis();
      if (input.signal.aborted || remaining <= 0) return transactionUnavailable();
      const scope = queryDatabase(input.db, input);
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise({ try: scope.close, catch: () => new QueryLifetimeExpired() }).pipe(
          Effect.ignore
        )
      );
      return yield* Effect.raceFirst(input.execute(scope.db), aborted(input.signal)).pipe(
        Effect.timeout(remaining)
      );
    })
  ).pipe(Effect.orElseSucceed(transactionUnavailable));
