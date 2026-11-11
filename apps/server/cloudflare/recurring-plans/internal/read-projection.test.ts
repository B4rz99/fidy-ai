import { DateTime, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../../d1-test-fixture";
import { prepareReadProjection } from "./read-projection";
import { prepareSelectedDocument } from "./store";
import { workspaceFromReadProjection, workspaceFromSnapshot } from "./query";
import { UserPreferences } from "../../../src/core/identity/contract";
import { Transaction } from "../../../src/core/transactions/contract";
import { RecurringPlanInput } from "../../../src/core/recurring-plans/contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000001";
const setup = Effect.fn(function* () {
  const db = yield* Effect.tryPromise(() => databases.acquire());
  yield* Effect.tryPromise(() => installTestSchema({ db }));
  const plan = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(RecurringPlanInput))
  )(
    yield* Schema.decodeEffect(Schema.toCodecJson(RecurringPlanInput))({
      name: "Plan",
      kind: "expense",
      currency: "COP",
      amountMode: "fixed",
      money: { amount: "1000", currency: "COP" },
      frequency: "monthly",
      firstDate: "2018-07-10",
      timeZone: "America/Bogota",
      counterparty: "Party",
    })
  );
  yield* Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0)"
        )
        .bind(userId),
      db
        .prepare(
          "INSERT INTO user_documents VALUES(?,'recurring-plan','{\"excludedTransactionIds\":[],\"suggestions\":[]}',10000)"
        )
        .bind(userId),
      db
        .prepare(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<99)
      INSERT INTO recurring_plans(user_id,id,position,pauses_json) SELECT ?,printf('40000000-0000-4000-8000-%012d',x),x,'[]' FROM n`)
        .bind(userId),
      db
        .prepare(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<99)
      INSERT INTO recurring_plan_revisions(user_id,plan_id,position,from_date,plan_json)
      SELECT p.user_id,p.id,n.x,date('2018-07-01','+'||n.x||' months'),json_set(?,'$.name','Revision '||n.x,'$.firstDate',date('2018-07-10','+'||n.x||' months')) FROM recurring_plans p CROSS JOIN n WHERE p.user_id=?`)
        .bind(plan, userId),
      db
        .prepare(
          "UPDATE recurring_plan_revisions SET plan_json=json_set(plan_json,'$.currency','USD','$.money.currency','USD','$.money.amount','1.25','$.timeZone','America/New_York') WHERE user_id=? AND plan_id='40000000-0000-4000-8000-000000000000' AND position=13"
        )
        .bind(userId),
      db
        .prepare(
          "INSERT INTO recurring_plan_fulfillments(user_id,id,plan_id,position,local_date,actual_date,amount,currency,settled,automatic,transaction_id) VALUES(?,'81000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000000',0,'2019-08-10','2019-08-10','1.25','USD',1,1,'82000000-0000-4000-8000-000000000001')"
        )
        .bind(userId),
      db
        .prepare(
          "INSERT INTO recurring_plan_exceptions(user_id,plan_id,position,local_date,skipped) VALUES(?,'40000000-0000-4000-8000-000000000001',0,'2020-03-10',1)"
        )
        .bind(userId),
    ])
  );
  return db;
});

it(
  "selects at most ten relevant revisions per plan for a compact month",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const now = DateTime.makeUnsafe("2022-09-05T00:30:00Z");
        const prepared = prepareReadProjection({
          now,
          query: { month: "2026-10", view: "compact" },
          db,
          users: { sql: "SELECT ? AS userId", params: [userId] },
        });
        const rows = yield* Effect.tryPromise(() => db.batch([...prepared.statements]));
        expect(rows[2]?.results.length).toBeLessThanOrEqual(1000);
        const projection = yield* prepared.decode(rows);
        expect(projection.schedule.plans).toHaveLength(100);
        expect(
          projection.editing.plans[0]?.revisions.map((revision) => revision.plan.name)
        ).toEqual(["Revision 0", "Revision 50", "Revision 99"]);
        expect(
          projection.schedule.plans[0]?.revisions.some((revision) => revision.from === "2019-08-01")
        ).toBe(true);
        expect(
          projection.schedule.plans[1]?.revisions.some((revision) => revision.from === "2020-03-01")
        ).toBe(true);
        const full = prepareSelectedDocument({
          db,
          users: { sql: "SELECT ? AS userId", params: [userId] },
        });
        const complete = yield* full.decode(
          yield* Effect.tryPromise(() => db.batch([...full.statements]))
        );
        expect(complete.plans[0]?.revisions).toHaveLength(100);
        const transaction = yield* Schema.decodeEffect(Schema.toCodecJson(Transaction))({
          id: "82000000-0000-4000-8000-000000000001",
          money: { amount: "1.25", currency: "USD" },
          direction: "outflow",
          counterparty: "Party",
          categoryId: userId,
          occurredAt: "2019-08-10T04:30:00.000Z",
          createdAt: "2019-08-10T04:30:00.000Z",
          revision: 0,
        });
        const observed = {
          snapshot: yield* Schema.decodeEffect(UserPreferences)({
            locale: "es-CO",
            timeZone: "America/Bogota",
          }),
          ranges: [
            Option.some({ transactions: [], complete: true }),
            Option.some({ transactions: [], complete: true }),
          ],
          selected: [transaction],
        };
        for (const query of [
          { month: "2026-10", view: "compact" },
          { month: "2022-08", previousMonth: "2019-02", view: "compact" },
          { month: "2017-01", view: "compact" },
        ] as const) {
          const selected = prepareReadProjection({
            now,
            db,
            users: { sql: "SELECT ? AS userId", params: [userId] },
            query,
          });
          const source = yield* selected.decode(
            yield* Effect.tryPromise(() => db.batch([...selected.statements]))
          );
          const input = { query, observed, now };
          expect(yield* workspaceFromReadProjection({ ...input, projection: source })).toEqual(
            yield* workspaceFromSnapshot({ ...input, document: complete })
          );
        }
        const input = {
          query: { month: "2026-10", view: "compact" } as const,
          now,
        };
        expect(
          (yield* workspaceFromReadProjection({ ...input, observed, projection }))
            .invalidFulfillmentIds
        ).toEqual([]);
        const changed = {
          ...observed,
          selected: [
            {
              ...transaction,
              money: {
                ...transaction.money,
                amount: yield* Schema.decodeEffect(Transaction.fields.money.fields.amount)("1.26"),
              },
            },
          ],
        };
        const corrected = yield* workspaceFromReadProjection({
          ...input,
          observed: changed,
          projection,
        });
        expect(corrected).toEqual(
          yield* workspaceFromSnapshot({ ...input, observed: changed, document: complete })
        );
        expect(corrected.invalidFulfillmentIds).toEqual(["81000000-0000-4000-8000-000000000001"]);
        expect(rows[2]?.results).toHaveLength(502);
        expect(complete.plans.reduce((sum, plan) => sum + plan.revisions.length, 0)).toBe(10000);
      })
    ),
  30000
);
