import { Option, Predicate, Schema } from "effect";

// A private test-transport field survives instrumentation Proxies around prepared statements.
const statementPreparation = "__fidyNativeD1Statement";
const Byte = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }));
const Binding = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
  Schema.Array(Byte),
]);
const Preparation = Schema.Struct({ sql: Schema.String, params: Schema.Array(Schema.Json) });
type Preparation = typeof Preparation.Type;
const Reply = Schema.Union([
  Schema.Struct({ success: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.Struct({ message: Schema.String, cause: Schema.optionalKey(Schema.String) }),
  }),
]);
type Query = Readonly<{ statements: ReadonlyArray<Preparation> }> &
  (
    | Readonly<{ operation: "all" | "run" | "batch" | "first" }>
    | Readonly<{ operation: "firstColumn"; column: string }>
  );
type Dispatch = (body: string) => Promise<Pick<Response, "ok" | "status" | "json">>;
type Execute = (query: Query) => Promise<Schema.Json>;
const normalizedBinding = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return Array.from(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  return value;
};

const bindings = (values: ReadonlyArray<unknown>): Option.Option<ReadonlyArray<Schema.Json>> => {
  const result: Schema.Json[] = [];
  for (const value of values) {
    const decoded = Schema.decodeUnknownOption(Binding)(normalizedBinding(value));
    if (Option.isNone(decoded)) return Option.none();
    result.push(decoded.value);
  }
  return Option.some(result);
};

const executor =
  (dispatch: Dispatch): Execute =>
  (query) =>
    dispatch(JSON.stringify(query))
      .then((response) => {
        if (!response.ok) throw new Error(`Native D1 fixture transport failed: ${response.status}`);
        return response.json();
      })
      .then((value: unknown) => {
        const reply = Schema.decodeUnknownSync(Reply)(value);
        if (reply.success) return reply.value;

        throw new Error(
          reply.error.message,
          reply.error.cause === undefined ? undefined : { cause: new Error(reply.error.cause) }
        );
      });
const statements = (
  native: D1Database,
  execute: Execute,
  nativeAccess: () => void
): Readonly<{
  prepare: (preparation: Preparation) => D1PreparedStatement;
  materialize: (preparation: Preparation) => D1PreparedStatement;
}> => {
  // This native target preserves the platform interface; SQL descriptors stay local until execution.
  const unavailable = (): never => {
    throw new Error("Unintercepted D1 fixture method");
  };
  const prototype: D1PreparedStatement = {
    bind: unavailable,
    all: unavailable,
    run: unavailable,
    first: unavailable,
    raw: unavailable,
  };
  const materialize = ({ sql, params }: Preparation): D1PreparedStatement => {
    nativeAccess();
    return native.prepare(sql).bind(...params);
  };
  const prepare = (preparation: Preparation): D1PreparedStatement =>
    new Proxy(prototype, {
      get(target, key, receiver): unknown {
        if (key === statementPreparation) return preparation;
        if (key === "bind") {
          return (...values: unknown[]): D1PreparedStatement => {
            const encoded = bindings(values);
            return Option.isSome(encoded)
              ? prepare({ sql: preparation.sql, params: encoded.value })
              : materialize({ sql: preparation.sql, params: [] }).bind(...values);
          };
        }
        if (key === "all" || key === "run") {
          return () => execute({ operation: key, statements: [preparation] });
        }
        if (key === "first") {
          return (column?: string) =>
            execute(
              column === undefined
                ? { operation: "first", statements: [preparation] }
                : { operation: "firstColumn", statements: [preparation], column }
            );
        }
        if (key === "raw") {
          return (options?: { columnNames: true } | Parameters<D1PreparedStatement["raw"]>[0]) =>
            options?.columnNames === true
              ? materialize(preparation).raw({ columnNames: true })
              : materialize(preparation).raw();
        }
        return Reflect.get(target, key, receiver);
      },
    });
  return { prepare, materialize };
};

/** Execute SQL only inside the real D1 binding, without synchronous proxy calls for each method. */
export const asynchronousNativeDatabase = ({
  native,
  dispatch,
  nativeAccess,
}: Readonly<{
  native: D1Database;
  dispatch: Dispatch;
  nativeAccess: () => void;
}>): D1Database => {
  const execute = executor(dispatch);
  const { prepare, materialize } = statements(native, execute, nativeAccess);
  const unavailable = (): never => {
    throw new Error("Unintercepted D1 fixture method");
  };
  const target: D1Database = {
    prepare: unavailable,
    batch: unavailable,
    exec: native.exec.bind(native),
    dump: native.dump.bind(native),
    withSession: native.withSession.bind(native),
  };
  return new Proxy(target, {
    get(target, key, receiver): unknown {
      if (key === "prepare") {
        return (sql: string): D1PreparedStatement =>
          Predicate.isString(sql) ? prepare({ sql, params: [] }) : native.prepare(sql);
      }
      if (key === "batch") {
        return (statements: D1PreparedStatement[]) => {
          const descriptions = statements.map((statement) =>
            Schema.decodeUnknownOption(Preparation)(Reflect.get(statement, statementPreparation))
          );
          if (descriptions.every(Option.isSome)) {
            return execute({ operation: "batch", statements: descriptions.map(Option.getOrThrow) });
          }
          return native.batch(
            statements.map((statement, index) => {
              const description = descriptions[index];
              return description !== undefined && Option.isSome(description)
                ? materialize(description.value)
                : statement;
            })
          );
        };
      }
      // Sessions/bookmarks, exec and deprecated dump keep the original platform path.
      if (key === "withSession" || key === "exec" || key === "dump") nativeAccess();
      return Reflect.get(target, key, receiver);
    },
  });
};
