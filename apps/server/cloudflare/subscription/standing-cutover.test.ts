import { Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { activeProUserCondition } from "../../src/shell/access-tier/operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const id = (kind: number): string => `${kind}4500000-0000-4000-8000-000000000001`;
const targets = ["users", "subscriptions", "billing_attempts"];
const selected = 1800000000123;
const ends = selected + 604800000;

const workPlans = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM billing_attempts WHERE followup_due_at_ms<=? ORDER BY followup_due_at_ms,id LIMIT 32"
      )
      .bind(ends),
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT COALESCE(SUM(amount_in_cents),0) FROM refund_attempts WHERE billing_attempt_id=? AND status<>'failed'"
      )
      .bind(id(4)),
  ]);
const verifyWorkPlans = Effect.fnUntraced(function* (
  db: D1Database,
  before: ReadonlyArray<D1Result>
) {
  const after = yield* wait(() => workPlans(db));
  expect(after[1]?.results).toEqual(before[1]?.results);
  const details = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ detail: Schema.String }))
  )(after[0]?.results);
  expect(details.map((row) => row.detail).join(" ")).toContain("SEARCH");
});

it.each([
  "valid",
  "changed-price",
  "changed-standing",
  "changed-no-charge",
  "interrupted-copy",
  "interrupted-swap",
] as const)(
  "preserves paid standing, commercial facts and original evidence or rejects %s history atomically",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* wait(() => databases.acquire());
        const noticeTarget = precedingSchema({
          current: precedingSchema({
            current: schemaStatements(
              yield* wait(() =>
                Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
              )
            ),
            history: yield* Schema.decodeEffect(CutoverHistory)(
              yield* wait(() =>
                Bun.file(
                  new URL("../ingestion/materialization-cutover.test-fixture.json", import.meta.url)
                ).text()
              )
            ),
          }),
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* wait(() =>
              Bun.file(
                new URL("../ingestion/forwarding-cutover.test-fixture.json", import.meta.url)
              ).text()
            )
          ),
        });
        const refundTarget = precedingSchema({
          current: noticeTarget,
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* wait(() =>
              Bun.file(new URL("./price-notice-cutover.test-fixture.json", import.meta.url)).text()
            )
          ),
        });
        const latest = precedingSchema({
          current: refundTarget,
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* wait(() =>
              Bun.file(new URL("./refund-cutover.test-fixture.json", import.meta.url)).text()
            )
          ),
        });
        const current = precedingSchema({
          current: latest,
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* wait(() =>
              Bun.file(new URL("./cancellation-cutover.test-fixture.json", import.meta.url)).text()
            )
          ),
        });
        const previous = precedingSchema({
          current,
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* wait(() =>
              Bun.file(new URL("./standing-cutover.test-fixture.json", import.meta.url)).text()
            )
          ),
        });
        const guide = yield* wait(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        yield* wait(() => db.batch(previous.map((sql) => db.prepare(sql))));
        yield* wait(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO users(rowid,id,service_market,locale,time_zone,created_at_ms,trial_started_at_ms,trial_ends_at_ms) VALUES(17,?,'CO','es-CO','America/Bogota',1,10,604800010)"
              )
              .bind(id(1)),
            db
              .prepare("INSERT INTO subscriptions(rowid,id,user_id) VALUES(27,?,?)")
              .bind(id(6), id(1)),
            db
              .prepare(`INSERT INTO payment_enrollments(id,subscription_id,price_id,billing_email,status,payment_source_mode,contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,payment_request_id,wompi_candidate_source_id,method,wompi_environment)
        VALUES(?,?,'22700000-0000-4000-8000-000000000001','payer@example.test','creating','create','{}','{}',100,900100,?,42,'card','sandbox')`)
              .bind(id(2), id(6), id(5)),
            db
              .prepare(
                "INSERT INTO payment_sources(id,subscription_id,origin_enrollment_id,wompi_environment,wompi_source_id,billing_email,method,verified_at_ms,archive_row_ref) VALUES(?,?,?,'sandbox',42,'payer@example.test','card',123,'source:original')"
              )
              .bind(id(3), id(6), id(2)),
            db.prepare("UPDATE payment_enrollments SET status='available' WHERE id=?").bind(id(2)),
            db
              .prepare(`INSERT INTO billing_attempts(rowid,id,user_id,enrollment_id,payment_request_id,payment_source_id,price_id,amount,currency,billing_period,service_market,tax_treatment,time_zone,wompi_environment,wompi_reference,created_at_ms)
        VALUES(37,?,?,?,?,?,'22700000-0000-4000-8000-000000000001','9900','COP','weekly','CO','not-taxable','America/Bogota','sandbox','fidy-original',100)`)
              .bind(id(4), id(1), id(2), id(5), id(3)),
            db
              .prepare(
                "UPDATE billing_attempts SET collection_state='sent',collection_sent_at_ms=101 WHERE id=?"
              )
              .bind(id(4)),
            db
              .prepare(
                "UPDATE billing_attempts SET no_charge_reference=wompi_reference,no_charge_environment=wompi_environment,no_charge_case_id='original-case',no_charge_operator_id='original-operator',no_charge_confirmed_at_ms=102 WHERE id=?"
              )
              .bind(id(4)),
            db
              .prepare(
                "INSERT INTO billing_provider_transactions(transaction_id,attempt_id,status,first_observed_at_ms,finalized_at_ms) VALUES('original-transaction',?,'APPROVED',?,?)"
              )
              .bind(id(4), selected + 1, selected),
            db
              .prepare(
                "UPDATE billing_attempts SET status='succeeded',finalized_at_ms=?,paid_starts_at_ms=?,paid_ends_at_ms=?,paid_renewal_anchor_ms=?,recovery_case_id=no_charge_case_id,recovery_reviewed_at_ms=? WHERE id=?"
              )
              .bind(selected, selected, ends, ends, selected + 1, id(4)),
            db
              .prepare(
                "UPDATE users SET paid_attempt_id=?,paid_price_id='22700000-0000-4000-8000-000000000001',paid_period_ends_at_ms=?,paid_renewal_anchor_ms=? WHERE id=?"
              )
              .bind(id(4), ends, ends, id(1)),
            db
              .prepare("UPDATE billing_attempts SET followup_due_at_ms=? WHERE id=?")
              .bind(ends, id(4)),
            db
              .prepare(
                "INSERT INTO user_documents(user_id,kind,document_json,revision) VALUES(?,'dashboard','{\"original\":true}',2)"
              )
              .bind(id(1)),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('past','removed',1,'Complete')"
            ),
            db.prepare(
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','subscriptions','initial:17','{\"historical\":\"unchanged\"}',1)"
            ),
          ])
        );
        const corruption = {
          valid: [],
          "changed-price": [
            "DROP TRIGGER billing_attempt_snapshot_immutable",
            "UPDATE billing_attempts SET amount='9901'",
          ],
          "changed-standing": ["UPDATE users SET paid_period_ends_at_ms=paid_period_ends_at_ms+1"],
          "changed-no-charge": [
            "DROP TRIGGER billing_no_charge_immutable_update",
            "UPDATE billing_attempts SET recovery_case_id='unexplained-case'",
          ],
          "interrupted-copy": [],
          "interrupted-swap": [],
        }[history];
        for (const sql of corruption) {
          yield* wait(() => db.prepare(sql).run());
        }
        const retained = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name"),
            ...targets.map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)),
            db.prepare("SELECT rowid,* FROM billing_provider_transactions ORDER BY rowid"),
            db.prepare("SELECT rowid,* FROM erasure_archives ORDER BY rowid"),
            db.prepare("SELECT rowid,* FROM user_documents ORDER BY rowid"),
          ]);
        const before = (yield* wait(retained)).map((result) => result.results);
        const condition = activeProUserCondition({ userId: id(1), nowEpochMs: ends + 1 });
        const access = (after: boolean = false): Promise<unknown> =>
          db
            .prepare(
              `SELECT ${after ? condition.sql : condition.sql.replaceAll("billing_attempt_context", "billing_attempts")} AS active`
            )
            .bind(...condition.params)
            .first("active");
        expect(yield* wait(access)).toBe(1);
        const workBefore = yield* wait(() => workPlans(db));
        const planBefore = yield* wait(() =>
          db
            .prepare(
              `EXPLAIN QUERY PLAN SELECT ${condition.sql.replaceAll("billing_attempt_context", "billing_attempts")}`
            )
            .bind(...condition.params)
            .all()
        );
        const objects = yield* wait(() =>
          db
            .prepare(
              "SELECT type,name FROM sqlite_schema WHERE type IN('view','trigger','index') AND sql IS NOT NULL"
            )
            .all<{ type: string; name: string }>()
        );
        const plan = [
          ...documentedSqlBlock({ guide, marker: "subscription-standing-preflight" }),
          ...targets.map((target) =>
            schemaDefinition({ source: current, target })
              .replace(/^(CREATE TABLE "?\w+"?)/u, `CREATE TABLE ${target}_1450`)
              .replace(/REFERENCES "?(subscriptions|billing_attempts)"?\(/gu, "REFERENCES $1_1450(")
          ),
          ...documentedSqlBlock({ guide, marker: "subscription-standing-copy" }),
          ...documentedSqlBlock({ guide, marker: "subscription-standing-copy-check" }),
          ...(history === "interrupted-copy"
            ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
            : []),
          ...objects.results.map((object) => `DROP ${object.type.toUpperCase()} "${object.name}"`),
          ...targets.filter((target) => target !== "users").map((target) => `DROP TABLE ${target}`),
          ...targets
            .filter((target) => target !== "users")
            .map((target) => `ALTER TABLE ${target}_1450 RENAME TO ${target}`),
          ...documentedSqlBlock({ guide, marker: "subscription-standing-user-remove" }),
          ...current.filter((sql) => /^CREATE (?:UNIQUE )?(?:VIEW|TRIGGER|INDEX) /u.test(sql)),
          ...(history === "interrupted-swap"
            ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
            : []),
          ...documentedSqlBlock({ guide, marker: "subscription-standing-verify" }),
        ];
        const apply = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(plan.map((sql) => db.prepare(sql)));
        if (history !== "valid") {
          yield* wait(() =>
            expect(apply()).rejects.toThrow("CHECK constraint failed: accepted = 1")
          );
          expect((yield* wait(retained)).map((result) => result.results)).toEqual(before);
          return;
        }
        yield* wait(apply);
        expect(
          (yield* wait(() => db.prepare("SELECT rowid,* FROM user_documents ORDER BY rowid").all()))
            .results
        ).toEqual(before[6]);
        yield* verifyWorkPlans(db, workBefore);
        expect(yield* wait(() => access(true))).toBe(1);
        const original = yield* Schema.decodeUnknownEffect(
          Schema.Record(Schema.String, Schema.Unknown)
        )(before[3]?.[0]);
        const columns = Object.keys(original)
          .map((name) => `"${name}"`)
          .join(",");
        expect(
          (yield* wait(() => db.prepare(`SELECT ${columns} FROM billing_attempt_context`).all()))
            .results
        ).toEqual(before[3]);
        expect(
          yield* wait(() =>
            db
              .prepare("SELECT current_paid_attempt_id FROM subscriptions WHERE id=?")
              .bind(id(6))
              .first("current_paid_attempt_id")
          )
        ).toBe(id(4));
        expect(
          (yield* wait(() =>
            db.prepare("SELECT rowid,* FROM erasure_archives ORDER BY rowid").all()
          )).results
        ).toEqual(before[5]);
        expect(
          (yield* wait(() =>
            db.prepare("SELECT rowid,* FROM billing_provider_transactions ORDER BY rowid").all()
          )).results
        ).toEqual(before[4]);
        const planAfter = yield* wait(() =>
          db
            .prepare(`EXPLAIN QUERY PLAN SELECT ${condition.sql}`)
            .bind(...condition.params)
            .all()
        );
        for (const plan of [planBefore, planAfter]) {
          const details = (yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ detail: Schema.String }))
          )(plan.results))
            .map((row) => row.detail)
            .join(" ");
          expect(details).toContain("SEARCH");
          expect(details).not.toMatch(/SCAN (?:a|s)\b/u);
        }
        yield* wait(() =>
          expect(
            db
              .prepare("UPDATE subscriptions SET current_paid_attempt_id=NULL WHERE id=?")
              .bind(id(6))
              .run()
          ).rejects.toThrow("subscription_paid_attempt_immutable")
        );
        expect(yield* wait(() => access(true))).toBe(1);
      })
    )
);
