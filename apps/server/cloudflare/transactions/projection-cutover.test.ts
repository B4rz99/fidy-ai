import { DateTime, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { Money, encodeMoneyAmount } from "../../src/core/_shared/money";
import { UtcTimestamp } from "../../src/core/_shared/time";
import { UserId } from "../../src/core/identity/contract";
import { isolatedTestDatabases } from "../d1-test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaObjectName,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { findRecurringSnapshot, readCompletePeriodAggregates } from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const owner = UserId.make("10000000-0000-4000-8000-000000000001");
const absent = "10000000-0000-4000-8000-000000000002";
const category = "10000000-0000-4000-8000-000000000016";
const stores = ["leaf", "state", "bucket", "digit"] as const;
const instant = (raw: string): Option.Option<number> =>
  Option.map(
    /[1-9]/u.test((/\.(\d+)/u.exec(raw)?.[1] ?? "").slice(3))
      ? Option.none()
      : Schema.decodeOption(UtcTimestamp)(raw),
    DateTime.toEpochMillis
  );
const Leaf = Schema.Struct({
  rowid: Schema.Int,
  occurred_at: Schema.String,
  created_at: Schema.String,
});
const State = Schema.Struct({ rowid: Schema.Int, first_captured_at: Schema.NullOr(Schema.String) });
const Bucket = Schema.Struct({ maximum: Schema.String, currency: Schema.String });

const prepareLeafCopies = Effect.fn(function* ({
  db,
  guide,
}: Readonly<{ db: D1Database; guide: string }>) {
  const guards: D1PreparedStatement[] = [];
  const copies: D1PreparedStatement[] = [];
  const block = (marker: string): ReadonlyArray<string> =>
    documentedSqlBlock({ guide, marker: "financial-projection-" + marker });
  const leaves = yield* Schema.decodeUnknownEffect(Schema.Array(Leaf))(
    (yield* wait(() =>
      db
        .prepare(
          "SELECT rowid,occurred_at,created_at FROM dashboard_projection_leaf ORDER BY rowid"
        )
        .all()
    )).results
  );
  for (const row of leaves) {
    const occurred = instant(row.occurred_at);
    const created = instant(row.created_at);
    guards.push(
      db.prepare(block("leaf-guard")[0] ?? "").bind(
        Option.isSome(occurred) && Option.isSome(created) ? 1 : 0,
        row.rowid,
        row.occurred_at,
        row.created_at,
        Option.getOrElse(occurred, () => 0),
        Option.getOrElse(created, () => 0)
      )
    );
    copies.push(
      db.prepare(block("leaf-copy")[0] ?? "").bind(
        Option.getOrElse(occurred, () => 0),
        Option.getOrElse(created, () => 0),
        row.rowid
      ),
      db.prepare(block("leaf-copy")[1] ?? "")
    );
  }
  return { guards, copies };
});
const prepareStateCopies = Effect.fn(function* ({
  db,
  guide,
}: Readonly<{ db: D1Database; guide: string }>) {
  const guards: D1PreparedStatement[] = [];
  const copies: D1PreparedStatement[] = [];
  const block = (marker: string): ReadonlyArray<string> =>
    documentedSqlBlock({ guide, marker: "financial-projection-" + marker });
  const states = yield* Schema.decodeUnknownEffect(Schema.Array(State))(
    (yield* wait(() =>
      db
        .prepare("SELECT rowid,first_captured_at FROM dashboard_projection_state ORDER BY rowid")
        .all()
    )).results
  );
  for (const row of states) {
    const captured =
      row.first_captured_at === null ? Option.some(null) : instant(row.first_captured_at);
    const ms = Option.getOrElse(captured, () => null);
    guards.push(
      db
        .prepare(block("state-guard")[0] ?? "")
        .bind(Option.isSome(captured) ? 1 : 0, row.rowid, row.first_captured_at, ms, ms)
    );
    copies.push(
      db.prepare(block("state-copy")[0] ?? "").bind(ms, row.rowid),
      db.prepare(block("state-copy")[1] ?? "")
    );
  }
  return { guards, copies };
});
const prepareCopies = Effect.fn(function* ({
  db,
  guide,
}: Readonly<{ db: D1Database; guide: string }>) {
  const guards: D1PreparedStatement[] = [];
  const copies: D1PreparedStatement[] = [];
  const block = (marker: string): ReadonlyArray<string> =>
    documentedSqlBlock({ guide, marker: "financial-projection-" + marker });
  const leaves = yield* prepareLeafCopies({ db, guide });
  const states = yield* prepareStateCopies({ db, guide });
  guards.push(...leaves.guards, ...states.guards);
  copies.push(...leaves.copies, ...states.copies);
  const buckets = yield* Schema.decodeUnknownEffect(Schema.Array(Bucket))(
    (yield* wait(() =>
      db.prepare("SELECT maximum,currency FROM dashboard_projection_bucket").all()
    )).results
  );
  for (const row of buckets) {
    guards.push(
      db
        .prepare(block("money-guard")[0] ?? "")
        .bind(
          Option.isSome(
            Schema.decodeUnknownOption(Money)({ amount: row.maximum, currency: row.currency })
          )
            ? 1
            : 0
        )
    );
  }
  return { guards, copies };
});

const histories = [
  "valid",
  "lossy-instant",
  "lossy-first-capture",
  "maximum-mismatch",
  "invalid-currency-precision",
  "outstanding-archive",
  "interrupted-copy",
  "interrupted-swap",
] as const;
const corruptions: Readonly<Record<(typeof histories)[number], ReadonlyArray<string>>> = {
  valid: [],
  "lossy-instant": ["UPDATE dashboard_projection_leaf SET occurred_at='2026-09-01T05:01:02.0031Z'"],
  "lossy-first-capture": [
    "UPDATE dashboard_projection_state SET first_captured_at='2026-09-01T05:01:02.0071Z' WHERE first_captured_at IS NOT NULL",
  ],
  "maximum-mismatch": ["UPDATE dashboard_projection_bucket SET max_minor='1'"],
  "invalid-currency-precision": [
    "UPDATE dashboard_projection_bucket SET maximum='0.0001',max_minor='1' WHERE currency='COP'",
  ],
  "outstanding-archive": [
    "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES('complete','dashboard_projection_leaf','initial:1','{}')",
  ],
  "interrupted-copy": [],
  "interrupted-swap": [],
};
const decodeRetainedRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
);
it.each(histories)(
  "preserves financial projection facts or atomically refuses %s cutover",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* wait(() => databases.acquire());
        const current = schemaStatements(
          yield* wait(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const manifest = yield* Schema.decodeEffect(CutoverHistory)(
          yield* wait(() =>
            Bun.file(new URL("./projection-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const source = precedingSchema({ current, history: manifest });
        yield* wait(() => db.batch(source.map((sql) => db.prepare(sql))));
        yield* wait(() =>
          db.batch([
            ...[owner, absent].map((id) =>
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
                )
                .bind(id)
            ),
            db
              .prepare(
                "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES('processing_grant','grant',?,'{}','disclosed','accepted',1,1)"
              )
              .bind(owner),
            ...[
              ["COP", "9007199254740993.01"],
              ["COP", "0.02"],
              ["JPY", "3"],
              ["KWD", "0.004"],
              ["UYW", "0.0001"],
              ["USD", "0"],
            ].map(([currency, amount], index) =>
              db
                .prepare(
                  "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES(?,?,?,?,'outflow',?,1788238862003,1788238862007)"
                )
                .bind(
                  `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
                  owner,
                  amount ?? "",
                  currency ?? "",
                  category
                )
            ),
            db
              .prepare(
                "UPDATE dashboard_projection_leaf SET occurred_at='2026-09-01T21:00:02.003+15:59',created_at='2026-08-31T13:02:02.007-15:59' WHERE user_id=?"
              )
              .bind(owner),
            db
              .prepare(
                "UPDATE dashboard_projection_state SET first_captured_at='2026-08-31T13:02:02.007-15:59',attempted_at_ms=1788238862011,cursor_id='retained-cursor' WHERE user_id=?"
              )
              .bind(owner),
            db
              .prepare(
                "UPDATE dashboard_projection_state SET readiness='rebuilding',version=0,cursor_id='unfinished',attempted_at_ms=19 WHERE user_id=?"
              )
              .bind(absent),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('complete','deleted-user',1,'Complete')"
            ),
            db.prepare(
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES('complete','transactions','initial:19','{}')"
            ),
          ])
        );
        for (const sql of corruptions[history]) {
          yield* wait(() => db.prepare(sql).run());
        }
        const snapshot = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            ...stores.map((store) =>
              db.prepare(`SELECT rowid,* FROM dashboard_projection_${store} ORDER BY rowid`)
            ),
            db.prepare("SELECT * FROM erasure_archives ORDER BY row_ref"),
            db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name"),
          ]);
        const before = (yield* wait(snapshot)).map((row) => row.results);
        const guide = yield* wait(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (marker: string): ReadonlyArray<D1PreparedStatement> =>
          documentedSqlBlock({ guide, marker: "financial-projection-" + marker }).map((sql) =>
            db.prepare(sql)
          );
        const checked = yield* prepareCopies({ db, guide });
        const affected = manifest.originalDefinitions.map(schemaObjectName);
        const replace = current.filter(
          (sql) =>
            affected.includes(schemaObjectName(sql)) ||
            manifest.introducedNames.includes(schemaObjectName(sql))
        );
        const plan = [
          ...block("preflight"),
          ...checked.guards,
          ...source
            .filter((sql) => /^CREATE (?:TRIGGER|VIEW) /u.test(sql))
            .map((sql) =>
              db.prepare(
                `DROP ${sql.startsWith("CREATE TRIGGER") ? "TRIGGER" : "VIEW"} "${schemaObjectName(sql)}"`
              )
            ),
          ...stores.map((store) =>
            db.prepare(
              schemaDefinition({ source: current, target: "transaction_projection_" + store })
            )
          ),
          ...checked.copies,
          ...block("aggregate-copy"),
          ...block("copy-check"),
          ...(history === "interrupted-copy"
            ? [db.prepare("INSERT INTO sql_assertions(scope,accepted) VALUES('interrupt',0)")]
            : []),
          ...block("swap"),
          ...(history === "interrupted-swap"
            ? [db.prepare("INSERT INTO sql_assertions(scope,accepted) VALUES('interrupt',0)")]
            : []),
          ...current
            .filter(
              (sql) =>
                /^CREATE (?:TRIGGER|VIEW) /u.test(sql) ||
                (sql.startsWith("CREATE INDEX transaction_projection_") && replace.includes(sql))
            )
            .map((sql) => db.prepare(sql)),
          ...block("verify"),
        ];
        if (history !== "valid") {
          yield* wait(() => expect(db.batch(plan)).rejects.toThrow(/CHECK constraint failed/u));
          expect((yield* wait(snapshot)).map((row) => row.results)).toEqual(before);
          return;
        }
        yield* wait(() => db.batch(plan));
        expect(
          yield* wait(() =>
            db
              .prepare(
                "SELECT fact_revision,first_captured_at_ms,time_zone,cursor_id,attempted_at_ms FROM transaction_projection_state WHERE user_id=?"
              )
              .bind(owner)
              .first()
          )
        ).toEqual({
          fact_revision: 6,
          first_captured_at_ms: 1788238862007,
          time_zone: "America/Bogota",
          cursor_id: "retained-cursor",
          attempted_at_ms: 1788238862011,
        });
        expect(
          yield* wait(() =>
            db
              .prepare(
                "SELECT fact_revision,first_captured_at_ms,time_zone FROM transaction_projection_state WHERE user_id=?"
              )
              .bind(absent)
              .first()
          )
        ).toEqual({ fact_revision: null, first_captured_at_ms: null, time_zone: null });
        expect(
          yield* wait(() =>
            db
              .prepare(
                "SELECT readiness,version,cursor_id,attempted_at_ms FROM transaction_projection_state WHERE user_id=?"
              )
              .bind(absent)
              .first()
          )
        ).toEqual({
          readiness: "rebuilding",
          version: 0,
          cursor_id: "unfinished",
          attempted_at_ms: 19,
        });
        expect(
          (yield* wait(() =>
            db.prepare("SELECT rowid,* FROM transaction_projection_leaf ORDER BY rowid").all()
          )).results
        ).toEqual(
          decodeRetainedRows(before[0]).map(({ occurred_at, created_at, ...row }) => ({
            ...row,
            occurred_at_ms: Option.getOrThrow(
              instant(Schema.decodeUnknownSync(Schema.String)(occurred_at))
            ),
            created_at_ms: Option.getOrThrow(
              instant(Schema.decodeUnknownSync(Schema.String)(created_at))
            ),
          }))
        );
        expect(
          (yield* wait(() =>
            db.prepare("SELECT rowid,* FROM transaction_projection_bucket ORDER BY rowid").all()
          )).results
        ).toEqual(
          decodeRetainedRows(before[2]).map(({ maximum: _maximum, max_minor, ...row }) => ({
            ...row,
            max_minor: max_minor === "" ? "0" : max_minor,
          }))
        );
        expect(
          (yield* wait(() =>
            db.prepare("SELECT rowid,* FROM transaction_projection_digit ORDER BY rowid").all()
          )).results
        ).toEqual(before[3]);
        const snapshotFacts = Option.getOrThrow(
          yield* findRecurringSnapshot({ db, userId: owner })
        );
        expect(DateTime.toEpochMillis(snapshotFacts.firstCapturedAt)).toBe(1788238862007);
        const period = {
          from: DateTime.makeUnsafe("2026-09-01T05:00:00Z"),
          toExclusive: DateTime.makeUnsafe("2026-09-02T05:00:00Z"),
        };
        const facts = Option.getOrThrow(
          yield* readCompletePeriodAggregates({ db, userId: owner, periods: [period, period] })
        );
        expect(
          facts.periods[0].aggregates.map((group) => [
            group.sum.currency,
            encodeMoneyAmount(group.sum.amount),
            encodeMoneyAmount(group.maximum.amount),
          ])
        ).toEqual([
          ["COP", "9007199254740993.03", "9007199254740993.01"],
          ["JPY", "3", "3"],
          ["KWD", "0.004", "0.004"],
          ["USD", "0", "0"],
          ["UYW", "0.0001", "0.0001"],
        ]);
        expect(
          (yield* wait(() => db.prepare("SELECT * FROM erasure_archives ORDER BY row_ref").all()))
            .results
        ).toEqual(before[4]);
      })
    ),
  30_000
);
