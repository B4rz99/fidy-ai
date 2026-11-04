import type { ErasureSourceSchemaInput } from "../contract";
import { generationAssertion } from "./generation";
import { Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { ErasureSourceFreezePlan, ErasureUnavailable } from "../../erasure-store/contract";
import { digestBytes } from "../../secret-material/operations";

export const freezePrefix = "fidy_source_retired_v1_";
const manifestName = freezePrefix + "manifest";
const planCodec = Schema.fromJsonString(ErasureSourceFreezePlan);
const actions = ["INSERT", "UPDATE", "DELETE"] as const;
const Table = Schema.Struct({ name: Schema.String, sql: Schema.String });
const Trigger = Schema.Struct({
  name: Schema.String,
  tableName: Schema.String,
  action: Schema.Literals(actions),
  sql: Schema.String,
});
const tableFilter =
  "type='table' AND sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '__cf_*' AND name NOT GLOB '_cf_*'";
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const hash = (text: string): Effect.Effect<string, ErasureUnavailable> =>
  digestBytes(new TextEncoder().encode(text)).pipe(
    Effect.map(Hex.encode),
    Effect.mapError(() => new ErasureUnavailable())
  );
const guardSql = ({
  name,
  table,
  action,
  generation,
}: Readonly<{
  name: string;
  table: string;
  action: (typeof actions)[number];
  generation: string;
}>): string =>
  `CREATE TRIGGER ${quote(name)} BEFORE ${action} ON ${quote(table)} WHEN (SELECT generation FROM erasure_control WHERE kind='published') = '${generation}' BEGIN SELECT RAISE(ABORT,'fidy_source_retired'); END`;
const manifestSql = (plan: ErasureSourceFreezePlan): Effect.Effect<string, ErasureUnavailable> =>
  Schema.encodeEffect(planCodec)(plan).pipe(
    Effect.map(
      (encoded) =>
        `CREATE TRIGGER ${quote(manifestName)} BEFORE UPDATE ON "erasure_control" WHEN (SELECT generation FROM erasure_control WHERE kind='published') = '${plan.generation}' BEGIN SELECT RAISE(ABORT,'fidy_source_retired:${encoded}'); END`
    ),
    Effect.mapError(() => new ErasureUnavailable())
  );
const io = <A>(work: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: work, catch: () => new ErasureUnavailable() });
export type Freeze = Readonly<{
  plan: ErasureSourceFreezePlan;
  statements: ReadonlyArray<D1PreparedStatement>;
  assertion: D1PreparedStatement;
  triggers: ReadonlyArray<typeof Trigger.Type>;
}>;
const guardsForTables = ({
  tables,
  generation,
}: Readonly<{ tables: ReadonlyArray<typeof Table.Type>; generation: string }>): Effect.Effect<
  Array<typeof Trigger.Type>,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    const triggers: Array<typeof Trigger.Type> = [];
    for (const table of tables) {
      for (const action of actions) {
        const suffix = yield* hash(`${generation}:${table.name}:${action}`);
        const name = freezePrefix + suffix;
        const sql = guardSql({ name, table: table.name, action, generation });
        triggers.push({ name, tableName: table.name, action, sql });
      }
    }
    return triggers;
  });
/** SQLite-internal/provider tables are inaccessible application schema; owner tables are all frozen, without a financial-row bound. */
export const prepareFreeze = (
  input: Readonly<{ db: D1Database; generation: string }>
): Effect.Effect<Freeze, ErasureUnavailable> =>
  Effect.gen(function* () {
    const generation = yield* Schema.decodeEffect(ErasureSourceFreezePlan.fields.generation)(
      input.generation
    );
    const rows = yield* io(() =>
      input.db
        .prepare(`SELECT name,sql FROM sqlite_schema WHERE ${tableFilter} ORDER BY name`)
        .all()
    );
    const tables = yield* Schema.decodeUnknownEffect(Schema.Array(Table))(rows.results);
    if (tables.length === 0) return yield* new ErasureUnavailable();
    const triggers = yield* guardsForTables({ tables, generation });
    const encodedTables = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Table)))(
      tables
    );
    const encodedTriggers = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(Trigger))
    )(triggers);
    const plan = {
      version: 1 as const,
      generation,
      tableCount: tables.length,
      tablesDigest: yield* hash(encodedTables),
      triggersDigest: yield* hash(encodedTriggers),
    };
    const manifest = yield* manifestSql(plan);
    const complete = [
      ...triggers,
      {
        name: manifestName,
        tableName: "erasure_control",
        action: "UPDATE" as const,
        sql: manifest,
      },
    ];
    const encodedComplete = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(Trigger))
    )(complete);
    const assertion = input.db
      .prepare(`SELECT json(CASE WHEN
    (SELECT count(*) FROM sqlite_schema WHERE ${tableFilter})=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN sqlite_schema s ON s.type='table' AND s.name=json_extract(e.value,'$.name') WHERE s.sql IS NULL OR s.sql<>json_extract(e.value,'$.sql'))
    AND (SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND name GLOB ?)=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN sqlite_schema s ON s.type='trigger' AND s.name=json_extract(e.value,'$.name') AND s.tbl_name=json_extract(e.value,'$.tableName') WHERE s.sql IS NULL OR s.sql<>json_extract(e.value,'$.sql'))
    THEN 'true' ELSE '' END) AS frozen`)
      .bind(tables.length, encodedTables, freezePrefix + "*", complete.length, encodedComplete);
    return {
      plan,
      triggers: complete,
      assertion,
      statements: complete.map((trigger) =>
        input.db.prepare(trigger.sql.replace("CREATE TRIGGER ", "CREATE TRIGGER IF NOT EXISTS "))
      ),
    };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const expectedObject = (
  object: ErasureSourceSchemaInput["object"],
  plan: ErasureSourceFreezePlan
): Effect.Effect<string, ErasureUnavailable> =>
  Effect.gen(function* () {
    if (object.name === manifestName && object.tableName === "erasure_control") {
      return yield* manifestSql(plan);
    }
    for (const action of actions) {
      const name = freezePrefix + (yield* hash(`${plan.generation}:${object.tableName}:${action}`));
      if (name === object.name) {
        return guardSql({ name, table: object.tableName, action, generation: plan.generation });
      }
    }
    return yield* new ErasureUnavailable();
  });
/** The immutable schema sentinel binds the atomic complete-set assertion to the external plan; application code has no DDL channel. */
export const classifySourceObject = (
  input: ErasureSourceSchemaInput
): Effect.Effect<"SourceControl" | "Application", ErasureUnavailable> =>
  Effect.gen(function* () {
    if (!input.object.name.startsWith(freezePrefix)) return "Application" as const;
    if (Option.isNone(input.freeze) || input.object.type !== "trigger") {
      return yield* new ErasureUnavailable();
    }
    const expected = yield* Schema.decodeEffect(ErasureSourceFreezePlan)(input.freeze.value);
    if (expected.generation !== input.generation) return yield* new ErasureUnavailable();
    const sql = yield* expectedObject(input.object, expected);
    if (sql !== input.object.sql) return yield* new ErasureUnavailable();
    const manifest = yield* manifestSql(expected);
    yield* io(() =>
      input.db.batch([
        generationAssertion({ db: input.db, generation: expected.generation }),
        input.db
          .prepare(
            "SELECT json(CASE WHEN EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=? AND tbl_name='erasure_control' AND sql=?) AND EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=? AND tbl_name=? AND sql=?) THEN 'true' ELSE '' END) AS owned"
          )
          .bind(manifestName, manifest, input.object.name, input.object.tableName, sql),
      ])
    );
    return "SourceControl" as const;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
