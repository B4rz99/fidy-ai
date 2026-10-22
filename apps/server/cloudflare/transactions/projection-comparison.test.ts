import { BigDecimal, type Cause, Config, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases, observeRetentionCost } from "../d1-test-fixture";
import { seedHistory } from "./history-growth.test-fixture";
import { findDashboardAggregate, repairDashboardProjection } from "./operations";
import { Currency, Money, encodeMoneyAmount } from "../../src/core/_shared/money";
import {
  Direction,
  type EffectiveTransactionAggregate,
} from "../../src/core/transactions/contract";
import { CategoryId } from "../../src/core/categories/contract";

const enabled =
  Effect.runSync(Config.String("INFRA_PERFORMANCE_MEASURE").pipe(Config.withDefault("0"))) === "1";
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000051";
const foreignUserId = "10000000-0000-4000-8000-000000000052";
const categoryId = "10000000-0000-4000-8000-000000000016";
const prefix = "20000000-0000-4000-8000-";
const from = 1577854800000;
const through = 1580274000000;
const fields =
  "user_id,id,amount,currency,direction,counterparty,category_id,notes,occurred_at,created_at,revision";
type Scenario = Readonly<{
  db: D1Database;
  count: number;
  linked: boolean;
  spacingMinutes: number;
}>;
type Mode = "direct" | "indexed" | "leaf" | "projected";
const Reader = Schema.Literals([
  "history",
  "recurring",
  "aggregate",
  "capture",
  "correction",
  "link",
  "unlink",
  "repair",
]);
type Reader = typeof Reader.Type;
const Measurement = Schema.fromJsonString(
  Schema.Struct({
    scenario: Schema.Literal("projection-comparison"),
    count: Schema.Int,
    spacingMinutes: Schema.Int,
    linked: Schema.Boolean,
    reader: Reader,
    mode: Schema.Literals(["direct", "indexed", "leaf", "projected"]),
    sample: Schema.Int,
    rowsRead: Schema.Int,
    rowsWritten: Schema.Int,
    statements: Schema.Int,
    elapsedMs: Schema.Finite,
  })
);
const Plan = Schema.fromJsonString(
  Schema.Struct({
    count: Schema.Int,
    spacingMinutes: Schema.Int,
    linked: Schema.Boolean,
    reader: Reader,
    mode: Schema.Literals(["direct", "indexed", "leaf", "projected"]),
    details: Schema.Array(Schema.String),
  })
);
const measure = <A, E>(
  input: Scenario &
    Readonly<{
      reader: Reader;
      mode: Mode;
      sample: number;
      run: (db: D1Database) => Effect.Effect<A, E>;
    }>
): Effect.Effect<A, E | Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
    const observed = observeRetentionCost(input.db);
    const start = performance.now();
    const value = yield* input.run(observed.database);
    const elapsedMs = performance.now() - start;
    const encoded = yield* Schema.encodeEffect(Measurement)({
      scenario: "projection-comparison",
      count: input.count,
      spacingMinutes: input.spacingMinutes,
      linked: input.linked,
      reader: input.reader,
      mode: input.mode,
      sample: input.sample,
      ...observed.cost(),
      statements: observed.statements().length,
      elapsedMs,
    });
    yield* Effect.sync(() => process.stdout.write(`INFRA_COST ${encoded}\n`));
    if (
      input.sample === 0 &&
      (input.reader === "history" || input.reader === "recurring" || input.reader === "aggregate")
    ) {
      const details = yield* Effect.tryPromise(() => observed.plans());
      const plan = yield* Schema.encodeEffect(Plan)({
        count: input.count,
        spacingMinutes: input.spacingMinutes,
        linked: input.linked,
        reader: input.reader,
        mode: input.mode,
        details,
      });
      yield* Effect.sync(() => process.stdout.write(`INFRA_PLAN ${plan}\n`));
    }
    return value;
  });

type Summary = Readonly<{
  currency: string;
  direction: string;
  categoryId: string;
  count: string;
  sum: string;
  maximum: string;
}>;
const summaries = (groups: ReadonlyArray<EffectiveTransactionAggregate>): ReadonlyArray<Summary> =>
  groups
    .map((group) => ({
      currency: group.sum.currency,
      direction: group.direction,
      categoryId: group.categoryId,
      count: String(group.count),
      sum: encodeMoneyAmount(group.sum.amount),
      maximum: encodeMoneyAmount(group.maximum.amount),
    }))
    .sort((left, right) =>
      `${left.currency}:${left.direction}:${left.categoryId}`.localeCompare(
        `${right.currency}:${right.direction}:${right.categoryId}`
      )
    );
const aggregateColumns = "amount,currency,direction,category_id";
const AggregateRows = Schema.Array(
  Schema.Struct({
    amount: Schema.String,
    currency: Currency,
    direction: Direction,
    category_id: CategoryId,
  })
);
const decodeAggregateRows = Schema.decodeUnknownSync(AggregateRows);
const decodeMoney = Schema.decodeSync(Money);
const aggregateRows = (rows: ReadonlyArray<unknown>): ReadonlyArray<Summary> => {
  const groups = new Map<string, EffectiveTransactionAggregate>();
  for (const row of decodeAggregateRows(rows)) {
    const fact = {
      money: decodeMoney({ amount: row.amount, currency: row.currency }),
      direction: row.direction,
      categoryId: row.category_id,
    };
    const key = `${fact.money.currency}:${fact.direction}:${fact.categoryId}`;
    const previous = groups.get(key);
    groups.set(key, {
      categoryId: fact.categoryId,
      direction: fact.direction,
      count: (previous?.count ?? 0n) + 1n,
      sum: {
        currency: fact.money.currency,
        amount: BigDecimal.sum(previous?.sum.amount ?? BigDecimal.make(0n, 0), fact.money.amount),
      },
      maximum: {
        currency: fact.money.currency,
        amount: BigDecimal.max(
          previous?.maximum.amount ?? BigDecimal.make(0n, 0),
          fact.money.amount
        ),
      },
    });
  }
  return summaries([...groups.values()]);
};
const directAggregate = (
  db: D1Database,
  table: "dashboard_effective_source" | "dashboard_projection_leaf" = "dashboard_effective_source"
): Effect.Effect<ReadonlyArray<Summary>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      db
        .prepare(
          `SELECT ${aggregateColumns} FROM ${table} WHERE user_id=? AND occurred_at >= '2020-01-01T05:00:00.000Z' AND occurred_at < '2020-01-29T05:00:00.000Z'`
        )
        .bind(userId)
        .all()
    );
    return aggregateRows(rows.results);
  });
const projectedAggregate = (db: D1Database): Effect.Effect<ReadonlyArray<Summary>> =>
  findDashboardAggregate({ db, userId, from, toExclusive: through }).pipe(
    Effect.map((value) => summaries(Option.getOrThrow(value)))
  );
const compareReads = (
  scenario: Scenario
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    for (const reader of ["history", "recurring", "aggregate"] as const) {
      yield* compareReader({ ...scenario, reader });
    }
  });
const compareReader = (
  input: Scenario & Readonly<{ reader: "history" | "recurring" | "aggregate" }>
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    for (let sample = 0; sample < 5; sample += 1) {
      const direct = yield* measure({
        ...input,
        mode: "direct",
        sample,
        run: (db) => readCandidate({ db, reader: input.reader, mode: "direct" }),
      });
      const projected = yield* measure({
        ...input,
        mode: "projected",
        sample,
        run: (db) => readCandidate({ db, reader: input.reader, mode: "projected" }),
      });
      expect(projected).toEqual(direct);
      if (!input.linked) {
        const indexed = yield* measure({
          ...input,
          mode: "indexed",
          sample,
          run: (db) => indexedCandidate(db, input.reader),
        });
        expect(indexed).toEqual(direct);
      }
      if (input.reader === "aggregate") {
        const leaf = yield* measure({
          ...input,
          mode: "leaf",
          sample,
          run: (db) => directAggregate(db, "dashboard_projection_leaf"),
        });
        expect(leaf).toEqual(direct);
        expect(direct).toContainEqual(
          expect.objectContaining({ currency: "COP", maximum: "9007199254740993.01" })
        );
        expect(direct).toContainEqual({
          currency: "KWD",
          direction: "outflow",
          categoryId,
          count: "1",
          sum: "0.004",
          maximum: "0.004",
        });
      }
    }
  });
const readCandidate = ({
  db,
  reader,
  mode,
}: Readonly<{
  db: D1Database;
  reader: "history" | "recurring" | "aggregate";
  mode: Mode;
}>): Effect.Effect<ReadonlyArray<unknown>, Cause.UnknownError> => {
  if (reader === "aggregate") {
    return mode === "direct" ? directAggregate(db) : projectedAggregate(db);
  }
  const table = mode === "direct" ? "dashboard_effective_source" : "dashboard_projection_leaf";
  const query =
    reader === "history"
      ? `SELECT ${fields} FROM ${table} WHERE user_id=? ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 101`
      : `SELECT id,amount,currency,counterparty,occurred_at,created_at FROM ${table} WHERE user_id=? AND direction='outflow' AND (occurred_at,id) > ('2020-01-15T00:00:00.000Z','') ORDER BY occurred_at,id LIMIT 128`;
  return Effect.tryPromise(() => db.prepare(query).bind(userId).all()).pipe(
    Effect.map((result) => result.results)
  );
};
const indexedCandidate = (
  db: D1Database,
  reader: "history" | "recurring" | "aggregate"
): Effect.Effect<ReadonlyArray<unknown>, Cause.UnknownError> => {
  const instantColumns =
    "strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch') AS occurred_at,strftime('%Y-%m-%dT%H:%M:%fZ',created_at_ms/1000.0,'unixepoch') AS created_at";
  const columns = {
    recurring: `id,amount,currency,counterparty,${instantColumns}`,
    history: `user_id,id,amount,currency,direction,counterparty,category_id,notes,${instantColumns},revision`,
    aggregate: aggregateColumns,
  }[reader];
  const selection = {
    history: "ORDER BY occurred_at_ms DESC,created_at_ms DESC,id DESC LIMIT 101",
    recurring:
      "AND direction='outflow' AND (occurred_at_ms,id) > (1579046400000,'') ORDER BY occurred_at_ms,id LIMIT 128",
    aggregate: "AND occurred_at_ms>=1577854800000 AND occurred_at_ms<1580274000000",
  }[reader];
  return Effect.tryPromise(() =>
    db
      .prepare(
        `SELECT ${columns} FROM transactions WHERE user_id=? AND deleted_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM transaction_reconciliation_decisions WHERE user_id=? AND state='linked') ${selection}`
      )
      .bind(userId, userId)
      .all()
  ).pipe(
    Effect.map((result) =>
      reader === "aggregate" ? aggregateRows(result.results) : result.results
    )
  );
};
const seedPrecision = (db: D1Database): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db.batch(
      [
        ["COP", "9007199254740993.01", from],
        ["COP", "0.02", through - 1],
        ["USD", "2.01", from + 60_001],
        ["JPY", "3", from + 86_400_000],
        ["KWD", "0.004", from + 86_400_000],
        ["UYW", "0.0001", from + 86_400_000],
        ["COP", "9999999999999999", from - 1],
        ["COP", "9999999999999999", through],
      ].map(([currency, amount, occurredAt], index) =>
        db
          .prepare(
            "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES(?,?,?,?,'outflow',?,?,?)"
          )
          .bind(
            `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            userId,
            amount,
            currency,
            categoryId,
            occurredAt,
            through + 86_400_000
          )
      )
    )
  ).pipe(Effect.asVoid);
const mutationSteps = (
  db: D1Database,
  mode: Exclude<Mode, "leaf" | "indexed">
): ReadonlyArray<Readonly<{ reader: Reader; statements: ReadonlyArray<D1PreparedStatement> }>> => {
  const first = `50000000-0000-4000-8000-00000000000${mode === "projected" ? 1 : 3}`;
  const second = `50000000-0000-4000-8000-00000000000${mode === "projected" ? 2 : 4}`;
  const before = {
    id: first,
    money: { amount: "1", currency: "COP" },
    direction: "outflow",
    categoryId,
    occurredAt: "2020-01-02T00:00:00.000Z",
    createdAt: "2020-01-02T00:00:00.000Z",
    revision: 0,
  };
  return [
    {
      reader: "capture",
      statements: [first, second].flatMap((id) => [
        db
          .prepare(
            "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms,user_decisions) VALUES(?,?,'1','COP','outflow',?,1577923200000,1577923200000,'{\"money\":true,\"direction\":true,\"occurredAt\":true,\"categoryId\":true}')"
          )
          .bind(id, userId, categoryId),
        db
          .prepare(
            "INSERT INTO source_attestations(id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at_ms) VALUES(?,?,?,'manual','CO','es-CO','America/Bogota','comparison-v1',1577923200000)"
          )
          .bind(id, userId, id),
      ]),
    },
    {
      reader: "correction",
      statements: [
        db
          .prepare(
            "INSERT INTO transaction_corrections(id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts,corrected_at_ms) VALUES(?,?,?,0,'[\"notes\"]',?,?,1577923200001)"
          )
          .bind(
            first,
            userId,
            first,
            JSON.stringify(before),
            JSON.stringify({ ...before, notes: "chosen", revision: 1 })
          ),
        db
          .prepare(
            "UPDATE transactions SET notes='chosen',revision=1,user_decisions=json_set(user_decisions,'$.notes',json('true')) WHERE user_id=? AND id=?"
          )
          .bind(userId, first),
      ],
    },
    {
      reader: "link",
      statements: [
        db
          .prepare(
            "INSERT INTO transaction_reconciliation_decisions(user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id,decided_at_ms) VALUES(?,?,?,'linked',?,1577923200002)"
          )
          .bind(userId, first, second, first),
        ...[first, second].map((id) =>
          db
            .prepare(
              "UPDATE transactions SET reconciliation_first_id=?,reconciliation_second_id=? WHERE user_id=? AND id=?"
            )
            .bind(first, second, userId, id)
        ),
      ],
    },
    {
      reader: "unlink",
      statements: [
        db
          .prepare(
            "UPDATE transaction_reconciliation_decisions SET state='keep-separate',visible_transaction_id=NULL,decided_at_ms=1577923200003 WHERE user_id=? AND first_transaction_id=? AND second_transaction_id=?"
          )
          .bind(userId, first, second),
        ...[first, second].map((id) =>
          db
            .prepare(
              "UPDATE transactions SET reconciliation_first_id=NULL,reconciliation_second_id=NULL WHERE user_id=? AND id=?"
            )
            .bind(userId, id)
        ),
      ],
    },
  ];
};
const measureMutations = (
  scenario: Scenario,
  mode: Exclude<Mode, "leaf" | "indexed">
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    for (const reader of ["capture", "correction", "link", "unlink"] as const) {
      yield* measure({
        ...scenario,
        reader,
        mode,
        sample: 0,
        run: (db) =>
          Effect.tryPromise(() =>
            db.batch([
              ...Option.getOrThrow(
                Option.fromUndefinedOr(
                  mutationSteps(db, mode).find((step) => step.reader === reader)
                )
              ).statements,
            ])
          ),
      });
    }
  });
const measureRepair = (
  scenario: Scenario
): Effect.Effect<
  void,
  | Cause.UnknownError
  | Schema.SchemaError
  | Effect.Error<ReturnType<typeof repairDashboardProjection>>
> =>
  Effect.gen(function* () {
    const expected = yield* directAggregate(scenario.db);
    const before = yield* Effect.tryPromise(() =>
      scenario.db
        .prepare(
          "SELECT fact_revision,first_captured_at,time_zone FROM dashboard_projection_state WHERE user_id=?"
        )
        .bind(userId)
        .first()
    );
    yield* Effect.tryPromise(() =>
      scenario.db
        .prepare("UPDATE dashboard_projection_state SET readiness='dirty' WHERE user_id=?")
        .bind(userId)
        .run()
    );
    const pages = yield* measure({
      ...scenario,
      reader: "repair",
      mode: "projected",
      sample: 0,
      run: (db) =>
        Effect.gen(function* () {
          for (let page = 1; page <= 2000; page += 1) {
            if ((yield* repairDashboardProjection({ db, userId })) === "ready") return page;
          }
          return yield* Effect.die("Projection repair exceeded benchmark bound");
        }),
    });
    expect(pages).toBeGreaterThan(1);
    expect(yield* projectedAggregate(scenario.db)).toEqual(expected);
    expect(
      yield* Effect.tryPromise(() =>
        scenario.db
          .prepare(
            "SELECT fact_revision,first_captured_at,time_zone FROM dashboard_projection_state WHERE user_id=?"
          )
          .bind(userId)
          .first()
      )
    ).toEqual(before);
    yield* measure({
      ...scenario,
      reader: "repair",
      mode: "direct",
      sample: 0,
      run: () => Effect.void,
    });
  });
const withoutProjections = (
  db: D1Database
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'dashboard_projection_*'"
        )
        .all()
    );
    const triggers = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          name: Schema.String.check(Schema.isPattern(/^dashboard_projection_[a-z_]+$/u)),
        })
      )
    )(rows.results);
    yield* Effect.tryPromise(() =>
      db.batch(triggers.map(({ name }) => db.prepare(`DROP TRIGGER ${name}`)))
    );
  });
it.skipIf(!enabled)(
  "compares exact financial reads and mutation/repair costs against native materializations",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const count of [200, 2_000, 20_000]) {
          for (const linked of [false, true]) {
            yield* runScenario({ count, linked, spacingMinutes: 20 });
          }
        }
        for (const linked of [false, true]) {
          yield* runScenario({ count: 20_000, linked, spacingMinutes: 1 });
        }
      })
    ),
  180_000
);
const runScenario = ({
  count,
  linked,
  spacingMinutes,
}: Readonly<{ count: number; linked: boolean; spacingMinutes: number }>): Effect.Effect<
  void,
  | Cause.UnknownError
  | Schema.SchemaError
  | Effect.Error<ReturnType<typeof repairDashboardProjection>>
> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    yield* Effect.tryPromise(() => installTestSchema({ db }));
    yield* Effect.tryPromise(() =>
      db.batch(
        [userId, foreignUserId].map((id) =>
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0)"
            )
            .bind(id)
        )
      )
    );
    for (const [subject, transactionPrefix] of [
      [userId, prefix],
      [foreignUserId, "30000000-0000-4000-8000-"],
    ] as const) {
      yield* seedHistory({
        db,
        subject,
        transactionPrefix,
        count,
        linked,
        linkedFraction: 1,
        spacingMinutes,
      });
    }
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES('processing_grant','comparison-grant',?,'{}','disclosed','accepted',0,0)"
        )
        .bind(userId)
        .run()
    );
    yield* seedPrecision(db);
    const scenario = { db, count, linked, spacingMinutes };
    yield* compareReads(scenario);
    yield* measureMutations(scenario, "projected");
    yield* measureRepair(scenario);
    yield* withoutProjections(db);
    yield* measureMutations(scenario, "direct");
  });
