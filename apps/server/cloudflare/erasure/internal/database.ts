import { Effect, Option } from "effect";
import { expectedGeneration, generationAssertion } from "./generation";
import { ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureRecoveryConfiguration } from "../contract";

type Queries = Pick<D1DatabaseSession, "prepare" | "batch">;
type Batch = <Row>(statements: D1PreparedStatement[]) => Promise<D1Result<Row>[]>;
const unsupported = (): Promise<never> => Promise.reject(new ErasureUnavailable());
const executeBatch =
  (
    input: Readonly<{
      configuration: ErasureRecoveryConfiguration;
      source: Queries;
      originals: WeakMap<D1PreparedStatement, D1PreparedStatement>;
    }>
  ): Batch =>
  <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
    Effect.runPromise(expectedGeneration(input.configuration))
      .then((expected) =>
        // Preserve native D1 refusals for the operation owner; the generation assertion remains
        // first in the same atomic unit, including when that unit is refused by an Audit trigger.
        input.source.batch<Row>([
          generationAssertion({ db: input.configuration.db, generation: expected.generation }),
          ...statements.map((statement) => input.originals.get(statement) ?? statement),
        ])
      )
      .then((rows) => rows.slice(1));

const firstRow = (result: D1Result, column: Option.Option<string>): unknown => {
  const row = result.results[0];
  if (row === undefined) return null;
  if (Option.isNone(column)) return row;
  if (typeof row !== "object" || row === null || !(column.value in row)) {
    throw new ErasureUnavailable();
  }
  return Reflect.get(row, column.value);
};
const guardedStatement = (
  input: Readonly<{
    statement: D1PreparedStatement;
    batch: Batch;
    originals: WeakMap<D1PreparedStatement, D1PreparedStatement>;
  }>
): D1PreparedStatement => {
  const wrapped = new Proxy(input.statement, {
    get: (target, property): unknown => {
      if (property === "bind") {
        return (...values: unknown[]): D1PreparedStatement =>
          guardedStatement({ ...input, statement: target.bind(...values) });
      }
      if (property === "raw") return unsupported;
      if (property === "run" || property === "all") {
        return (): Promise<D1Result> =>
          input.batch([target]).then((rows) => {
            const row = rows[0];
            if (row === undefined) throw new ErasureUnavailable();
            return row;
          });
      }
      if (property === "first") {
        return (column?: string): Promise<unknown> =>
          input.batch([target]).then((rows) => {
            const row = rows[0];
            if (row === undefined) throw new ErasureUnavailable();
            return firstRow(row, Option.fromUndefinedOr(column));
          });
      }
      return Reflect.get(target, property, target);
    },
  });
  input.originals.set(wrapped, input.statement);
  return wrapped;
};
const guardQueries = <Source extends Queries>(
  configuration: ErasureRecoveryConfiguration,
  source: Source
): Source => {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const batch = executeBatch({ configuration, source, originals });
  return new Proxy(source, {
    get: (target, property): unknown => {
      if (property === "prepare") {
        return (query: string): D1PreparedStatement =>
          guardedStatement({ statement: target.prepare(query), batch, originals });
      }
      if (property === "batch") return batch;
      return Reflect.get(target, property, target);
    },
  });
};

/** Every supported unit rechecks the external recovery generation in its native transaction. exec, dump and raw tuple access are unavailable; native row queries and Sessions remain guarded. */
export const guardedDatabase = (configuration: ErasureRecoveryConfiguration): D1Database => {
  const database = guardQueries(configuration, configuration.db);
  return new Proxy(database, {
    get: (target, property): unknown => {
      if (property === "exec" || property === "dump") return unsupported;
      if (property === "withSession") {
        return (bookmark?: D1SessionBookmark): D1DatabaseSession =>
          guardQueries(configuration, configuration.db.withSession(bookmark));
      }
      return Reflect.get(target, property, target);
    },
  });
};
