import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { BigDecimal, Clock, Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import type {
  RecurringEdit,
  RecurringFulfillment,
  RecurringPlanInput,
} from "../../src/core/recurring-plans/contract";
import { RecurringWorkspace } from "../../src/shell/recurring-plans/contract";
import {
  alice,
  bob,
  category,
  nativeTransactionJourney,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

const planId = "40000000-0000-4000-8000-000000000123";

const money: typeof RecurringFulfillment.Encoded.money = {
  amount: "9007199254740993.15",
  currency: "USD",
};

const plan: typeof RecurringPlanInput.Encoded = {
  name: "Arriendo",
  kind: "expense",
  currency: "USD",
  amountMode: "fixed",
  money,
  firstDate: "2000-01-31",
  frequency: "monthly",
  timeZone: "America/Bogota",
};

const month = "/recurring-plans?month=2024-02";

const fulfillment: Omit<typeof RecurringFulfillment.Encoded, "transactionId"> = {
  id: "40000000-0000-4000-8000-000000000151",
  planId,
  date: "2024-02-29",
  actualDate: "2024-02-29",
  money,
  settled: true,
};

const read = Effect.fn(function* (response: Response) {
  expect(response.status).toBe(200);

  return (yield* Schema.decodeUnknownEffect(
    Schema.Struct({ data: Schema.toCodecJson(RecurringWorkspace) })
  )(yield* native(() => response.json()))).data;
});

const browserWrite = (
  db: Effect.Success<typeof nativeTransactionJourney>,
  subject: typeof alice,
  request: { path: string; method: string; body: unknown }
): Effect.Effect<Response> =>
  native(() =>
    db.send(
      new Request("https://api.fidyapp.com" + request.path, {
        method: request.method,
        headers: {
          origin: "https://app.fidyapp.com",
          cookie: "__Host-fidy_session=" + subject.bearer,
          "Fidy-Session-Binding": subject.session,
          "content-type": "application/json",
        },
        body: JSON.stringify(request.body),
      })
    )
  );

const capture = Effect.fn(function* (
  db: Effect.Success<typeof nativeTransactionJourney>,
  subject: typeof alice
) {
  const result = yield* browserWrite(db, subject, {
    path: "/transactions",
    method: "POST",
    body: {
      money,
      direction: "outflow",
      categoryId: category,
      occurredAt: "2024-02-29T18:00:00Z",
    },
  });

  expect(result.status).toBe(201);

  return (yield* Schema.decodeUnknownEffect(
    Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
  )(yield* native(() => result.json()))).data.id;
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "fulfills a long-lived plan exactly once after a lost response under current User authority",
    () =>
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;
        const token = "fin_abcdefgh_" + "5".repeat(43);
        yield* seedNativePAT({
          db,
          userId: alice.user,
          token,
          scopes: ["read", "write"],
          current: yield* Clock.currentTimeMillis,
        });

        const edit = (
          expectedRevision: number,
          change: typeof RecurringEdit.Encoded,
          key: string
        ): Effect.Effect<Response> =>
          native(() =>
            db.send(
              new Request("https://api.fidyapp.com/recurring-plans/edits", {
                method: "POST",
                headers: {
                  authorization: "Bearer " + token,
                  "content-type": "application/json",
                  "Fidy-Retry-Key": key,
                },
                body: JSON.stringify({ expectedRevision, edit: change }),
              })
            )
          );

        expect((yield* read(yield* native(() => db.browser(0, month)))).document.revision).toBe(0);
        expect((yield* edit(0, { kind: "create", id: planId, plan }, "create")).status).toBe(200);

        const fulfill = (): Effect.Effect<Response> =>
          edit(1, { kind: "fulfill", fulfillment }, "lost-fulfillment");

        yield* native(() =>
          db.exec(
            "CREATE TRIGGER refuse_recurring_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='credential_call' AND NEW.operation='recurringPlans.applyRecurringEdit' BEGIN SELECT RAISE(ABORT,'audit_unavailable'); END"
          )
        );
        expect((yield* fulfill()).status).toBe(503);
        expect(
          yield* native(() =>
            db.exec(
              "SELECT (SELECT count(*) FROM recurring_plan_fulfillments) AS marks,(SELECT count(*) FROM canonical_request_receipts) AS receipts,(SELECT count(*) FROM commercial_allowance_consumptions) AS charges"
            )
          )
        ).toEqual([{ marks: 0, receipts: 1, charges: 1 }]);
        yield* native(() => db.exec("DROP TRIGGER refuse_recurring_audit"));
        const original = yield* fulfill();
        expect(original.status).toBe(200);
        const retained = yield* native(() => original.text());
        const replay = yield* fulfill();
        expect(replay.status).toBe(200);
        expect(yield* native(() => replay.text())).toBe(retained);
        const workspace = yield* read(yield* native(() => db.browser(0, month)));
        expect(workspace.document.revision).toBe(2);
        expect(workspace.document.fulfillments.map(({ id }) => id)).toEqual([fulfillment.id]);
        const actual = workspace.document.fulfillments[0]?.money;
        expect(actual?.currency).toBe(money.currency);
        expect(actual && BigDecimal.format(actual.amount)).toBe(money.amount);
        expect(workspace.occurrences[0]).toMatchObject({
          planId,
          date: fulfillment.date,
          status: "completed",
        });
        expect(
          (yield* read(yield* native(() => db.browser(0, month + "&status=upcoming")))).occurrences
        ).toEqual([]);
        expect(
          yield* native(() =>
            db.exec(
              "SELECT (SELECT count(*) FROM audit_entries WHERE record_type='credential_call' AND operation='recurringPlans.applyRecurringEdit' AND outcome='accepted') AS calls,(SELECT count(*) FROM transactions) AS movements"
            )
          )
        ).toEqual([{ calls: 3, movements: 0 }]);
        expect(workspace.previousMonth).toBe("2023-12");
        expect((yield* read(yield* native(() => db.browser(1, month)))).document.plans).toEqual([]);
        expect(
          yield* native(() =>
            db.exec("SELECT count(*) AS charges FROM commercial_allowance_consumptions")
          )
        ).toEqual([{ charges: 2 }]);
        yield* native(() => db.exec("UPDATE pats SET revoked_at_ms=issued_at_ms"));
        expect((yield* fulfill()).status).toBe(401);
      })
  );
  test.effect(
    "rechecks an associated Effective Transaction and refuses an occurrence from another User",
    () =>
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;

        const subjectEdit = (
          subject: typeof alice,
          expectedRevision: number,
          edit: typeof RecurringEdit.Encoded
        ): Effect.Effect<Response> =>
          browserWrite(db, subject, {
            path: "/recurring-plans/edits",
            method: "POST",
            body: { expectedRevision, edit },
          });

        expect((yield* subjectEdit(alice, 0, { kind: "create", id: planId, plan })).status).toBe(
          200
        );
        const foreign = yield* capture(db, bob);
        const own = yield* capture(db, alice);

        const fulfill = (transactionId: string): typeof RecurringEdit.Encoded => ({
          kind: "fulfill",
          fulfillment: { ...fulfillment, transactionId },
        });

        expect((yield* subjectEdit(bob, 0, fulfill(foreign))).status).toBe(400);
        expect((yield* subjectEdit(alice, 1, fulfill(foreign))).status).toBe(400);
        expect((yield* subjectEdit(alice, 1, fulfill(own))).status).toBe(200);
        const current = yield* read(yield* native(() => db.browser(0, month)));
        expect(current.linkedTransactions.map((entry) => entry.id)).toEqual([own]);
        expect(current.occurrences[0]?.status).toBe("completed");
        expect(
          (yield* browserWrite(db, alice, {
            path: "/transactions/" + own,
            method: "PUT",
            body: { expectedRevision: 0, changes: { money: { amount: "11.10", currency: "USD" } } },
          })).status
        ).toBe(200);
        const corrected = yield* read(yield* native(() => db.browser(0, month)));
        expect(corrected.invalidFulfillmentIds).toEqual([fulfillment.id]);
        expect(corrected.occurrences[0]?.status).toBe("unconfirmed");
        expect(corrected.document.revision).toBe(2);
        yield* native(() =>
          db.exec(
            "UPDATE transaction_projection_leaf SET category_revision='unknown-release' WHERE id=?",
            own
          )
        );
        expect((yield* native(() => db.browser(0, month))).status).toBe(503);
        yield* native(() =>
          db.exec("UPDATE web_sessions SET revoked_at_ms=created_at_ms WHERE id=?", alice.session)
        );
        expect((yield* native(() => db.browser(0, month))).status).toBe(401);
      })
  );
  test.effect(
    "returns every supported plan revision and replays a full-size fulfillment receipt",
    () =>
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;
        const token = "fin_abcdefgh_" + "2".repeat(43);
        yield* seedNativePAT({
          db,
          userId: alice.user,
          token,
          scopes: ["read", "write"],
          current: yield* Clock.currentTimeMillis,
        });
        const plans = 100;
        const revisions = 100;
        yield* native(() =>
          db.exec(
            "INSERT INTO user_documents VALUES(?,'recurring-plan',?,1)",
            alice.user,
            JSON.stringify({ excludedTransactionIds: [], suggestions: [] })
          )
        );
        yield* native(() =>
          db.exec(
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<99) INSERT INTO recurring_plans SELECT ?,printf('40000000-0000-4000-8000-%012d',i),i,'[]',NULL FROM n",
            alice.user
          )
        );
        yield* native(() =>
          db.exec(
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<99) INSERT INTO recurring_plan_revisions SELECT p.user_id,p.id,i,date('2000-01-01',printf('+%d month',i)),json_set(?,'$.name',printf('Renta %d',i)) FROM recurring_plans p CROSS JOIN n WHERE p.user_id=?",
            JSON.stringify(plan),
            alice.user
          )
        );
        const full = yield* read(yield* native(() => db.browser(0, month)));
        expect(full.document.plans).toHaveLength(plans);
        expect(full.document.plans.every((entry) => entry.revisions.length === revisions)).toBe(
          true
        );

        const earlier = yield* read(
          yield* native(() => db.browser(0, month + "&previousMonth=2003-02&view=compact"))
        );

        expect(earlier.previousMonth).toBe("2003-01");
        expect(earlier.previous).toHaveLength(plans);
        expect(earlier.previous.every((item) => item.plan.name === "Renta 37")).toBe(true);
        expect(earlier.document.plans.every((entry) => entry.revisions.length === 2)).toBe(true);
        const mark = { ...fulfillment, planId: "40000000-0000-4000-8000-000000000099" };

        const fulfill = (): Effect.Effect<Response> =>
          native(() =>
            db.send(
              new Request("https://api.fidyapp.com/recurring-plans/edits", {
                method: "POST",
                headers: {
                  authorization: "Bearer " + token,
                  "content-type": "application/json",
                  "Fidy-Retry-Key": "large-fulfillment",
                },
                body: JSON.stringify({
                  expectedRevision: 1,
                  edit: { kind: "fulfill", fulfillment: mark },
                }),
              })
            )
          );

        const committed = yield* fulfill();
        expect(committed.status).toBe(200);
        const body = yield* native(() => committed.text());
        expect(body.length).toBeGreaterThan(2_097_152);
        expect(
          yield* native(() =>
            db.exec(
              "SELECT min(length(part)>0 AND length(CAST(part AS BLOB))<1000000) AS bounded FROM canonical_receipt_parts"
            )
          )
        ).toEqual([{ bounded: 1 }]);
        const replay = yield* fulfill();
        expect(replay.status).toBe(200);
        expect(yield* native(() => replay.text())).toBe(body);

        const batch = (): Effect.Effect<Response> =>
          native(() =>
            db.send(
              new Request("https://api.fidyapp.com/operations/atomic-batch", {
                method: "POST",
                headers: {
                  authorization: "Bearer " + token,
                  "content-type": "application/json",
                  "Fidy-Retry-Key": "large-batch",
                },
                body: JSON.stringify({
                  calls: [
                    {
                      callId: mark.id,
                      operation: "recurringPlans.applyRecurringEdit",
                      input: {
                        payload: {
                          expectedRevision: 2,
                          edit: {
                            kind: "fulfill",
                            fulfillment: {
                              ...mark,
                              id: "40000000-0000-4000-8000-000000000152",
                              date: "2024-03-31",
                              actualDate: "2024-03-31",
                            },
                          },
                        },
                      },
                    },
                  ],
                }),
              })
            )
          );

        const accepted = yield* batch();
        expect(accepted.status).toBe(200);
        const original = yield* native(() => accepted.text());
        expect(original.length).toBeGreaterThan(2_097_152);
        const recovered = yield* batch();
        expect(recovered.status).toBe(200);
        expect(yield* native(() => recovered.text())).toBe(original);
        yield* native(() => db.exec("UPDATE canonical_request_receipts SET accepted_at_ms=0"));
        expect((yield* native(() => db.checkWork(alice.user))).status).toBe(204);
        yield* native(() => db.exec("SELECT 1 FROM canonical_receipt_parts LIMIT 1")).pipe(
          Effect.repeat({
            until: (rows) => rows.length === 0,
            schedule: Schedule.spaced("50 millis"),
          }),
          Effect.timeout("5 seconds")
        );
        expect(
          yield* native(() =>
            db.exec("SELECT count(*) AS receipts FROM canonical_request_receipts")
          )
        ).toEqual([{ receipts: 0 }]);
        expect((yield* fulfill()).status).toBe(400);
        expect(
          yield* native(() => db.exec("SELECT count(*) AS marks FROM recurring_plan_fulfillments"))
        ).toEqual([{ marks: 2 }]);
      })
  );
});
