import { Config, DateTime, Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { UserId } from "../../src/core/identity/contract";
import { isolatedTestDatabases, observeRetentionCost } from "../d1-test-fixture";
import { CutoverHistory, precedingSchema, schemaStatements } from "../schema-cutover.test-fixture";
import { discoverBudgetCrossingUsers, noteBudgetCrossingEvaluation } from "./operations";

const enabled =
  Effect.runSync(Config.String("INFRA_PERFORMANCE_MEASURE").pipe(Config.withDefault("0"))) === "1";
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const user = (ordinal: number): UserId =>
  UserId.make(`14690000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`);
const original = Schema.Struct({ discovery: Schema.String, attempt: Schema.Array(Schema.String) });
const Measurement = Schema.Struct({
  cold: Schema.Int,
  scopes: Schema.Int,
  kind: Schema.Literals(["work", "publication"]),
  mode: Schema.Literals(["original", "shared"]),
  discovery: Schema.Struct({ rowsRead: Schema.Int, rowsWritten: Schema.Int }),
  attempt: Schema.Struct({ rowsRead: Schema.Int, rowsWritten: Schema.Int }),
});
const measurements: Array<typeof Measurement.Type> = [];
const scenarios = [
  { cold: 0, scopes: 1, kind: "work" as const },
  { cold: 2000, scopes: 1, kind: "work" as const },
  { cold: 2000, scopes: 100, kind: "work" as const },
  { cold: 2000, scopes: 32, kind: "publication" as const },
];
type Scenario = (typeof scenarios)[number];
type Mode = "original" | "shared";
const scopeStatement = (
  db: D1Database,
  kind: Scenario["kind"],
  mode: Mode
): D1PreparedStatement => {
  if (mode === "shared") {
    return db.prepare(
      kind === "work"
        ? "INSERT INTO budget_evaluation_work(user_id,occurred_at_ms) VALUES(?,?)"
        : "INSERT INTO budget_publications(user_id,delivery_group_id,detected_at_ms) VALUES(?,?,1)"
    );
  }
  return db.prepare(
    kind === "work"
      ? "INSERT INTO budget_state(kind,user_id,occurred_at) VALUES('work',?,?)"
      : "INSERT INTO budget_state(kind,user_id,record_id,detected_at_ms,version) VALUES('publication',?,?,1,NULL)"
  );
};
const scopeIdentity = (kind: Scenario["kind"], mode: Mode, scope: number): string | number => {
  if (kind === "publication") return `group-${scope}`;
  const milliseconds = 1767225600000 + scope;
  return mode === "shared" ? milliseconds : DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
};
const seedScopes = Effect.fn(function* (db: D1Database, scenario: Scenario, mode: Mode) {
  const seeds: D1PreparedStatement[] = [];
  for (let ordinal = 0; ordinal < 33 + scenario.cold; ordinal++) {
    seeds.push(
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
        )
        .bind(user(ordinal))
    );
    seeds.push(
      db
        .prepare(
          mode === "shared"
            ? "INSERT INTO budget_user_state(user_id,first_budget_id,first_created_at_ms,offer_requested_at_ms) VALUES(?,'first',1,1)"
            : "INSERT INTO budget_state(kind,user_id,budget_id,created_at_ms,offer_requested_at_ms,first_last_evaluated_at_ms,version,last_evaluated_at_ms) VALUES('user',?,'first',1,1,0,NULL,NULL)"
        )
        .bind(user(ordinal))
    );
    if (ordinal >= 33) continue;
    for (let scope = 0; scope < scenario.scopes; scope++) {
      seeds.push(
        scopeStatement(db, scenario.kind, mode).bind(
          user(ordinal),
          scopeIdentity(scenario.kind, mode, scope)
        )
      );
    }
  }
  for (let offset = 0; offset < seeds.length; offset += 250) {
    yield* Effect.tryPromise(() => db.batch(seeds.slice(offset, offset + 250)));
  }
});
it.skipIf(!enabled).each(scenarios)(
  "compares original discovery/attempt costs with one User clock: %j",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const source = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const history = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./work-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const originalQueries = yield* Schema.decodeEffect(Schema.fromJsonString(original))(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./scheduling.test-fixture.json", import.meta.url)).text()
          )
        );
        const outputs: Array<ReadonlyArray<UserId>> = [];
        for (const mode of ["original", "shared"] as const) {
          const db = yield* Effect.tryPromise(() => databases.acquire());
          yield* Effect.tryPromise(() =>
            db.batch(
              (mode === "shared" ? source : precedingSchema({ current: source, history })).map(
                (sql) => db.prepare(sql)
              )
            )
          );
          yield* seedScopes(db, scenario, mode);
          const discovery = observeRetentionCost(db);
          const selected =
            mode === "shared"
              ? yield* discoverBudgetCrossingUsers({ db: discovery.database })
              : (yield* Schema.decodeUnknownEffect(
                  Schema.Array(Schema.Struct({ user_id: UserId }))
                )(
                  (yield* Effect.tryPromise(() =>
                    discovery.database.prepare(originalQueries.discovery).bind(16).all()
                  )).results
                )).map((row) => row.user_id);
          expect(selected).toHaveLength(16);
          outputs.push(selected);
          const attempt = observeRetentionCost(db);
          if (mode === "shared") {
            yield* noteBudgetCrossingEvaluation({
              db: attempt.database,
              userId: user(0),
              now: 10000,
            });
          } else {
            yield* Effect.tryPromise(() =>
              attempt.database.batch(
                originalQueries.attempt.map((sql) =>
                  attempt.database.prepare(sql).bind(10000, user(0))
                )
              )
            );
          }
          measurements.push({
            ...scenario,
            mode,
            discovery: discovery.cost(),
            attempt: attempt.cost(),
          });
        }
        expect(outputs[0]).toEqual(outputs[1]);
      })
    ),
  30000
);
afterAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (!enabled) return;
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Measurement)))(
        measurements
      );
      yield* Effect.tryPromise(() =>
        Bun.write(
          new URL("../../../../docs/research/budget-scheduling-measurements.json", import.meta.url),
          encoded
        )
      );
    })
  )
);
