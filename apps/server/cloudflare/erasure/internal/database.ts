import { Effect, Option } from "effect";
import { expectedGeneration, generationAssertion } from "./generation";
import { ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureRecoveryConfiguration } from "../contract";
import type { RecoveryMeasurement } from "./measurement";

import type { ProtectedCommand, ProtectedExecution } from "./protected-contract";
import { commandBindings } from "./command-bindings";

const commands = new WeakMap<D1PreparedStatement, ProtectedCommand>();
type Queries = Pick<D1DatabaseSession, "prepare" | "batch">;
type Batch = (statements: D1PreparedStatement[]) => Promise<D1Result[]>;
const unsupported = (): Promise<never> => Promise.reject(new ErasureUnavailable());
const executeBatch =
  (
    input: Readonly<{
      configuration: ErasureRecoveryConfiguration;
      source: Queries;
      originals: WeakMap<D1PreparedStatement, D1PreparedStatement>;
      measurement: Option.Option<RecoveryMeasurement>;
      execution: Option.Option<ProtectedExecution>;
      bookmark: () => Option.Option<D1SessionBookmark>;
      observeBookmark: (bookmark: Option.Option<D1SessionBookmark>) => void;
    }>
  ): Batch =>
  (statements: D1PreparedStatement[]): Promise<D1Result[]> =>
    Option.isSome(input.execution)
      ? Promise.resolve()
          .then(() =>
            Option.isSome(input.execution)
              ? input.execution.value({
                  commands: statements.map((statement) => {
                    const command = commands.get(statement);
                    if (command === undefined) throw new ErasureUnavailable();
                    return command;
                  }),
                  bookmark: input.bookmark(),
                })
              : Promise.reject(new ErasureUnavailable())
          )
          .then((result) => {
            input.observeBookmark(result.bookmark);
            return result.rows;
          })
      : (Option.isSome(input.measurement)
          ? input.measurement.value.generation(() =>
              Effect.runPromise(expectedGeneration(input.configuration))
            )
          : Effect.runPromise(expectedGeneration(input.configuration))
        )
          .then((expected) => {
            // Preserve native D1 refusals for the operation owner; the generation assertion remains
            // first in the same atomic unit, including when that unit is refused by an Audit trigger.
            const run = (): Promise<D1Result[]> =>
              input.source.batch([
                generationAssertion({
                  db: input.configuration.db,
                  generation: expected.generation,
                }),
                ...statements.map((statement) => input.originals.get(statement) ?? statement),
              ]);
            return Option.isSome(input.measurement) ? input.measurement.value.database(run) : run();
          })
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
    command: ProtectedCommand;
    recordCommands: boolean;
    batch: Batch;
    originals: WeakMap<D1PreparedStatement, D1PreparedStatement>;
  }>
): D1PreparedStatement => {
  const wrapped = new Proxy(input.statement, {
    get: (target, property): unknown => {
      if (property === "bind") {
        return (...values: unknown[]): D1PreparedStatement => {
          const statement = target.bind(...values);
          return guardedStatement({
            ...input,
            statement,
            command: {
              sql: input.command.sql,
              params: input.recordCommands ? commandBindings(values) : [],
            },
          });
        };
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
  if (input.recordCommands) {
    commands.set(input.statement, input.command);
    commands.set(wrapped, input.command);
  }
  input.originals.set(wrapped, input.statement);
  return wrapped;
};
const guardQueries = <Source extends Queries>(
  input: Readonly<{
    configuration: ErasureRecoveryConfiguration;
    source: Source;
    measurement: Option.Option<RecoveryMeasurement>;
    execution: Option.Option<ProtectedExecution>;
    initialBookmark: Option.Option<D1SessionBookmark>;
  }>
): Source => {
  const { configuration, source, measurement, execution, initialBookmark } = input;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  let bookmark = Option.getOrElse(initialBookmark, () => "first-unconstrained");
  const currentBookmark = (): Option.Option<D1SessionBookmark> =>
    bookmark === "first-primary" || bookmark === "first-unconstrained"
      ? Option.none()
      : Option.some(bookmark);
  const getBookmark = (): ReturnType<D1DatabaseSession["getBookmark"]> =>
    Option.getOrNull(currentBookmark());
  const batch = executeBatch({
    configuration,
    source,
    originals,
    measurement,
    execution,
    bookmark: () => Option.map(initialBookmark, () => bookmark),
    observeBookmark: (next) => {
      if (
        Option.isSome(next) &&
        next.value.trim() !== "" &&
        (Option.isNone(currentBookmark()) || bookmark.localeCompare(next.value.trim()) < 0)
      ) {
        bookmark = next.value.trim();
      }
    },
  });
  return new Proxy(source, {
    get: (target, property): unknown => {
      if (property === "prepare") {
        return (query: string): D1PreparedStatement =>
          guardedStatement({
            statement: target.prepare(query),
            command: { sql: query, params: [] },
            recordCommands: Option.isSome(execution),
            batch,
            originals,
          });
      }
      if (property === "batch") return batch;
      if (property === "getBookmark" && Option.isSome(execution)) return getBookmark;
      return Reflect.get(target, property, target);
    },
  });
};

/** Every supported unit rechecks the external recovery generation in its native transaction. exec, dump and raw tuple access are unavailable; native row queries and Sessions remain guarded. */
export const guardedDatabase = (
  configuration: ErasureRecoveryConfiguration &
    Readonly<{
      measurement: Option.Option<RecoveryMeasurement>;
      execution: Option.Option<ProtectedExecution>;
    }>
): D1Database => {
  const { measurement, execution } = configuration;
  const database = guardQueries({
    configuration,
    source: configuration.db,
    measurement,
    execution,
    initialBookmark: Option.none(),
  });
  return new Proxy(database, {
    get: (target, property): unknown => {
      if (property === "exec" || property === "dump") return unsupported;
      if (property === "withSession") {
        return (bookmark?: D1SessionBookmark): D1DatabaseSession =>
          guardQueries({
            configuration,
            source: configuration.db.withSession(bookmark),
            measurement,
            execution,
            initialBookmark: Option.some(
              bookmark?.trim() === "" || bookmark === undefined
                ? "first-unconstrained"
                : bookmark.trim()
            ),
          });
      }
      return Reflect.get(target, property, target);
    },
  });
};
