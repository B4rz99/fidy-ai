import { withErasureRecovery } from "../erasure/runtime";
import { RecurringWorkspace } from "../../src/shell/recurring-plans/contract";
import type { CanonicalWork } from "../canonical-operations/contract";
import type { QueryCaller } from "../canonical-work/operations";
import { installTestSchema, isolatedTestDatabases, isolatedTestStorage } from "../d1-test-fixture";
import { executeCanonicalQuery, executeCanonicalWork } from "../canonical-operations/operations";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import { UserId } from "../../src/core/identity/contract";
import { RecurringSeriesPage } from "../../src/core/recurring/contract";
import { evaluateRecurringSeries } from "../recurring/operations";
import { afterAll, expect, it } from "vitest";
import { type Cause, Clock, DateTime, Effect, Option, Schema } from "effect";
import {
  dailyAuditBudget,
  dailyAuditCount,
  utcDayMilliseconds,
} from "../../src/shell/audit/operations";

const users = ["10000000-0000-4000-8000-000000000051", "10000000-0000-4000-8000-000000000052"];
const sessions = ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"];
const databases = isolatedTestDatabases();
const recoveryStorage = isolatedTestStorage();
const bearer = (index: number): string => String(index + 1).repeat(43);
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((value) => new Uint8Array(value));

const seedUser = ({
  db,
  user,
  index,
  current,
}: Readonly<{
  db: D1Database;
  user: string;
  index: number;
  current: number;
}>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const verifierDigest = yield* Effect.tryPromise(() => digest(`verifier${index}`));
    const tokenDigest = yield* Effect.tryPromise(() => digest(bearer(index)));
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
          )
          .bind(user, current),
        db
          .prepare(
            "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'consumed', ?, ?)"
          )
          .bind(
            `10000000-0000-4000-8000-00000000007${index}`,
            `ABCD-123${index}`,
            verifierDigest,
            user,
            current,
            current + 600000
          ),
        db
          .prepare(
            "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(
            sessions[index],
            `10000000-0000-4000-8000-00000000007${index}`,
            user,
            tokenDigest,
            current,
            current + 600000,
            current + 3600000,
            current + 7776000000
          ),
      ])
    );
  });

const setup = (): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    yield* Effect.tryPromise(() =>
      installTestSchema({
        db,
        sources: [
          ...new Bun.Glob("*.sql").scanSync({
            cwd: new URL("../migrations/", import.meta.url).pathname,
          }),
        ]
          .sort()
          .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
      })
    );
    const current = DateTime.nowUnsafe().epochMilliseconds;
    yield* Effect.forEach(users, (user, index) => seedUser({ db, user, index, current }), {
      discard: true,
    });
    return db;
  });
afterAll(() => databases.dispose());
afterAll(() => recoveryStorage.dispose());

const transactionCount = (
  db: D1Database,
  subject: QueryCaller
): Effect.Effect<number, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const result = yield* executeCanonicalQuery({
      db,
      subject,
      operation: CanonicalOperationId.make("transactions.listTransactions"),
      input: { query: {} },
      bucket: Option.none(),
    });
    const response = Option.getOrThrow(result);
    expect(response.status).toBe(200);
    const body = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ data: Schema.Array(Schema.Unknown) })
    )(yield* Effect.tryPromise(() => response.json()));
    return body.data.length;
  });

it(
  "persists revision-bound recurring edits through the canonical D1 owner",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const subject = {
          userId: users[0] ?? "",
          id: sessions[0] ?? "",
          digest: yield* Effect.tryPromise(() => digest(bearer(0))),
        };
        const response = yield* executeCanonicalWork({
          db,
          subject,
          current: DateTime.nowUnsafe().epochMilliseconds,
          bucket: Option.none(),
          hostedFence: Option.none(),
          oauthConfirmation: Option.none(),
          inference: Option.none(),
          work: {
            _tag: "Call",
            operation: CanonicalOperationId.make("recurringPlans.applyRecurringEdit"),
            input: {
              payload: {
                expectedRevision: 0,
                edit: {
                  kind: "create",
                  id: "40000000-0000-4000-8000-000000000123",
                  plan: {
                    name: "Arriendo",
                    kind: "expense",
                    currency: "COP",
                    amountMode: "fixed",
                    money: { amount: "1000000", currency: "COP" },
                    firstDate: "2026-10-31",
                    timeZone: "America/Bogota",
                    frequency: "monthly",
                  },
                },
              },
            },
          },
        });
        const body = yield* Effect.tryPromise(() => response.text());
        expect(response.status, body).toBe(200);
        const read = yield* executeCanonicalQuery({
          db,
          subject,
          operation: CanonicalOperationId.make("recurringPlans.getRecurringWorkspace"),
          input: { query: { month: "2026-10" } },
          bucket: Option.none(),
        });
        expect(Option.getOrThrow(read).status).toBe(200);
        expect(yield* Effect.tryPromise(() => Option.getOrThrow(read).text())).toContain(
          "Arriendo"
        );
      })
    ),
  30000
);

const planId = "40000000-0000-4000-8000-000000000123";
const planInput = {
  name: "Arriendo",
  kind: "expense",
  currency: "COP",
  amountMode: "fixed",
  money: { amount: "1000000", currency: "COP" },
  firstDate: "2026-10-31",
  timeZone: "America/Bogota",
  frequency: "monthly",
  counterparty: "Propietario",
};
const fixture = (): Effect.Effect<
  Readonly<{ db: D1Database; subjects: ReadonlyArray<QueryCaller> }>,
  Cause.UnknownError
> =>
  Effect.gen(function* () {
    const db = yield* setup();
    const subjects = yield* Effect.forEach(users, (userId, index) =>
      Effect.gen(function* () {
        return {
          userId,
          id: sessions[index] ?? "",
          digest: yield* Effect.tryPromise(() => digest(bearer(index))),
        };
      })
    );
    return { db, subjects };
  });
const call = (db: D1Database, subject: QueryCaller, work: CanonicalWork): Effect.Effect<Response> =>
  executeCanonicalWork({
    db,
    subject,
    work,
    current: DateTime.nowUnsafe().epochMilliseconds,
    bucket: Option.none(),
    hostedFence: Option.none(),
    oauthConfirmation: Option.none(),
    inference: Option.none(),
  });
const edit = (revision: number, change: object): CanonicalWork => ({
  _tag: "Call",
  operation: CanonicalOperationId.make("recurringPlans.applyRecurringEdit"),
  input: { payload: { expectedRevision: revision, edit: change } },
});
const read = (
  db: D1Database,
  subject: QueryCaller
): Effect.Effect<typeof RecurringWorkspace.Type, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const result = yield* executeCanonicalQuery({
      db,
      subject,
      operation: CanonicalOperationId.make("recurringPlans.getRecurringWorkspace"),
      input: { query: { month: "2026-10" } },
      bucket: Option.none(),
    });
    const response = Option.getOrThrow(result);
    expect(response.status).toBe(200);
    const parsed = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ data: Schema.toCodecJson(RecurringWorkspace) })
    )(yield* Effect.tryPromise(() => response.json()));
    return parsed.data;
  });

it(
  "detected history stays outside the plan until explicit review, and dismissal, restoration and linking persist",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO onboarding_consent_records (id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, accepted_at_ms) VALUES (?, ?, '{}', 'disclosure', 'decision', 0, 0)"
            )
            .bind(owner.userId, owner.userId)
            .run()
        );
        for (const occurredAt of [
          "2026-07-10T12:00:00.000Z",
          "2026-08-10T12:00:00.000Z",
          "2026-09-10T12:00:00.000Z",
        ]) {
          const captured = yield* call(db, owner, {
            _tag: "Call",
            operation: CanonicalOperationId.make("transactions.createTransaction"),
            input: {
              payload: {
                money: planInput.money,
                direction: "outflow",
                counterparty: "Propietario",
                categoryId: "10000000-0000-4000-8000-000000000001",
                occurredAt,
              },
            },
          });
          expect(captured.status).toBe(201);
        }
        const evaluationSteps = 6;
        for (let index = 0; index < evaluationSteps; index++) {
          yield* evaluateRecurringSeries({ db, userId: UserId.make(owner.userId) });
        }
        const result = yield* executeCanonicalQuery({
          db,
          subject: owner,
          operation: CanonicalOperationId.make("recurring.listRecurringSeries"),
          input: { query: {} },
          bucket: Option.none(),
        });
        const seriesResponse = Option.getOrThrow(result);
        expect(seriesResponse.status).toBe(200);
        const detected = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(RecurringSeriesPage) })
        )(yield* Effect.tryPromise(() => seriesResponse.json()));
        expect(detected.data.series).toHaveLength(1);
        const series = Option.getOrThrow(Option.fromUndefinedOr(detected.data.series[0]));
        expect((yield* read(db, owner)).document.plans).toEqual([]);
        expect(
          (yield* call(
            db,
            owner,
            edit(0, { kind: "suggestion", seriesId: series.id, action: "dismiss" })
          )).status
        ).toBe(200);
        expect((yield* read(db, owner)).document.suggestions).toEqual([
          { seriesId: series.id, disposition: "dismissed" },
        ]);
        expect(
          (yield* call(
            db,
            owner,
            edit(1, { kind: "suggestion", seriesId: series.id, action: "restore" })
          )).status
        ).toBe(200);
        expect((yield* read(db, owner)).document.suggestions).toEqual([]);
        expect(
          (yield* call(db, owner, edit(2, { kind: "create", id: planId, plan: planInput }))).status
        ).toBe(200);
        expect(
          (yield* call(
            db,
            owner,
            edit(3, { kind: "suggestion", seriesId: series.id, action: "link", planId })
          )).status
        ).toBe(200);
        const linked = yield* read(db, owner);
        expect(linked.document.plans).toHaveLength(1);
        expect(linked.document.suggestions).toEqual([
          { seriesId: series.id, disposition: "linked", planId },
        ]);
      })
    ),
  30000
);

it(
  "manual tracking creates no Transaction and a later captured payment replaces it without double fulfillment",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        expect(
          (yield* call(
            db,
            owner,
            edit(0, { kind: "create", id: planId, plan: { ...planInput, firstDate: "2026-10-10" } })
          )).status
        ).toBe(200);
        const mark = {
          id: "40000000-0000-4000-8000-000000000151",
          planId,
          date: "2026-10-10",
          actualDate: "2026-10-10",
          money: { amount: "400000", currency: "COP" },
          settled: false,
        };
        expect(
          (yield* call(db, owner, edit(1, { kind: "fulfill", fulfillment: mark }))).status
        ).toBe(200);
        expect((yield* read(db, owner)).occurrences[0]?.status).toBe("partial");
        expect(yield* transactionCount(db, owner)).toBe(0);
        const captured = yield* call(db, owner, {
          _tag: "Call",
          operation: CanonicalOperationId.make("transactions.createTransaction"),
          input: {
            payload: {
              money: planInput.money,
              direction: "outflow",
              counterparty: "Propietario",
              categoryId: "10000000-0000-4000-8000-000000000001",
              occurredAt: "2026-10-10T12:00:00.000Z",
            },
          },
        });
        expect(captured.status).toBe(201);
        const transaction = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
        )(yield* Effect.tryPromise(() => captured.json()));
        const linked = {
          ...mark,
          id: "40000000-0000-4000-8000-000000000152",
          money: planInput.money,
          transactionId: transaction.data.id,
          settled: true,
        };
        expect((yield* read(db, owner)).occurrences[0]?.status).toBe("partial");
        expect(
          (yield* call(db, owner, edit(2, { kind: "fulfill", fulfillment: linked }))).status
        ).toBe(400);
        expect(
          (yield* call(
            db,
            owner,
            edit(2, { kind: "fulfill", fulfillment: linked, replaces: mark.id })
          )).status
        ).toBe(200);
        const replaced = yield* read(db, owner);
        expect(replaced.occurrences[0]?.status).toBe("completed");
        expect(replaced.occurrences[0]?.fulfillments).toHaveLength(1);
        expect(replaced.occurrences[0]?.completed).toEqual(replaced.occurrences[0]?.plan.money);
        expect(yield* transactionCount(db, owner)).toBe(1);
      })
    ),
  30000
);
it(
  "rejects stale revisions and fabricated accounts without replacing either User's plan document",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        const other = Option.getOrThrow(Option.fromUndefinedOr(subjects[1]));
        expect(
          (yield* call(db, owner, edit(0, { kind: "create", id: planId, plan: planInput }))).status
        ).toBe(200);
        const before = yield* read(db, owner);
        expect(
          (yield* call(
            db,
            owner,
            edit(0, { kind: "skip", planId, date: "2026-10-31", skipped: true })
          )).status
        ).toBe(400);
        expect(
          (yield* call(
            db,
            owner,
            edit(1, {
              kind: "edit",
              planId,
              date: "2026-10-31",
              scope: "forward",
              plan: { ...planInput, accountId: planId },
            })
          )).status
        ).toBe(400);
        expect(
          (yield* call(
            db,
            other,
            edit(0, { kind: "skip", planId, date: "2026-10-31", skipped: true })
          )).status
        ).toBe(400);
        expect((yield* read(db, owner)).document).toEqual(before.document);
        expect((yield* read(db, other)).document.plans).toEqual([]);
      })
    ),
  30000
);
it.each([
  { correction: "Money", changes: { money: { amount: "800000", currency: "COP" } } },
  { correction: "Counterparty", changes: { counterparty: "Otro comercio" } },
])(
  "revalidates retained automatic matches after a $correction Correction and persists reversal",
  ({ changes }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        const other = Option.getOrThrow(Option.fromUndefinedOr(subjects[1]));
        const captured = yield* call(db, owner, {
          _tag: "Call",
          operation: CanonicalOperationId.make("transactions.createTransaction"),
          input: {
            payload: {
              money: planInput.money,
              direction: "outflow",
              counterparty: "Propietario",
              categoryId: "10000000-0000-4000-8000-000000000001",
              occurredAt: "2026-10-10T12:00:00.000Z",
            },
          },
        });
        const capturedBody = yield* Effect.tryPromise(() => captured.clone().text());
        expect(captured.status, capturedBody).toBe(201);
        const transaction = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
        )(yield* Effect.tryPromise(() => captured.json()));
        expect(
          (yield* call(
            db,
            owner,
            edit(0, { kind: "create", id: planId, plan: { ...planInput, firstDate: "2026-10-11" } })
          )).status
        ).toBe(200);
        const matched = yield* read(db, owner);
        expect(matched.occurrences[0]?.status).toBe("completed");
        expect(matched.document.fulfillments).toEqual([]);
        expect((yield* read(db, owner)).document.revision).toBe(1);
        expect(
          (yield* call(
            db,
            owner,
            edit(1, {
              kind: "create",
              id: "40000000-0000-4000-8000-000000000124",
              plan: { ...planInput, firstDate: "2026-10-11" },
            })
          )).status
        ).toBe(200);
        const competing = yield* read(db, owner);
        expect(competing.occurrences.filter((item) => item.status === "completed")).toHaveLength(1);
        const corrected = yield* call(db, owner, {
          _tag: "Call",
          operation: CanonicalOperationId.make("transactions.updateTransaction"),
          input: {
            params: { id: transaction.data.id },
            payload: {
              expectedRevision: 0,
              changes,
            },
          },
        });
        expect(corrected.status, yield* Effect.tryPromise(() => corrected.clone().text())).toBe(
          200
        );
        expect((yield* read(db, owner)).invalidFulfillmentIds).toEqual([transaction.data.id]);
        expect(
          (yield* call(db, other, edit(0, { kind: "reverse", fulfillmentId: transaction.data.id })))
            .status
        ).toBe(400);
        expect(
          (yield* call(db, owner, edit(2, { kind: "reverse", fulfillmentId: transaction.data.id })))
            .status
        ).toBe(200);
        expect((yield* read(db, owner)).occurrences[0]?.status).not.toBe("completed");
      })
    ),
  30000
);
it(
  "rolls back a plan when its accepted Audit cannot commit, and refuses a revoked session",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "CREATE TRIGGER recurring_test_audit_failure BEFORE INSERT ON pat_audit WHEN NEW.operation = 'recurringPlans.applyRecurringEdit' AND NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'test unavailable'); END"
            )
            .run()
        );
        expect(
          (yield* call(db, owner, edit(0, { kind: "create", id: planId, plan: planInput }))).status
        ).toBe(503);
        expect((yield* read(db, owner)).document.revision).toBe(0);
        yield* Effect.tryPromise(() =>
          db.prepare("DROP TRIGGER recurring_test_audit_failure").run()
        );
        expect(
          (yield* call(db, owner, edit(0, { kind: "create", id: planId, plan: planInput }))).status
        ).toBe(200);
        yield* Effect.tryPromise(() =>
          db
            .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
            .bind(DateTime.nowUnsafe().epochMilliseconds, sessions[0])
            .run()
        );
        expect(
          (yield* call(
            db,
            owner,
            edit(1, { kind: "skip", planId, date: "2026-10-31", skipped: true })
          )).status
        ).toBe(401);
        yield* Effect.tryPromise(() =>
          db
            .prepare("UPDATE web_sessions SET revoked_at_ms = NULL WHERE id = ?")
            .bind(sessions[0])
            .run()
        );
        expect((yield* read(db, owner)).document.revision).toBe(1);
      })
    ),
  30000
);

it(
  "allows editing a plan with decades of empty history",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        const subject = subjects[0];
        if (subject === undefined) return;
        const created = yield* call(
          db,
          subject,
          edit(0, { kind: "create", id: planId, plan: { ...planInput, firstDate: "2000-01-31" } })
        );
        expect(created.status).toBe(200);
        const paused = yield* call(
          db,
          subject,
          edit(1, { kind: "lifecycle", planId, date: "2026-10-14", action: "pause" })
        );
        expect(paused.status).toBe(200);
        expect((yield* read(db, subject)).document.revision).toBe(2);
      })
    ),
  30000
);

it(
  "keeps transaction completion under the occurrence's once and frozen forward settings",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        const expense = { ...planInput, firstDate: "2026-10-10" };
        const income = { ...expense, kind: "income", timeZone: "Pacific/Kiritimati" };
        expect(
          (yield* call(db, owner, edit(0, { kind: "create", id: planId, plan: expense }))).status
        ).toBe(200);
        expect(
          (yield* call(
            db,
            owner,
            edit(1, { kind: "edit", planId, date: "2026-10-10", scope: "once", plan: income })
          )).status
        ).toBe(200);
        const captured = yield* call(db, owner, {
          _tag: "Call",
          operation: CanonicalOperationId.make("transactions.createTransaction"),
          input: {
            payload: {
              money: planInput.money,
              direction: "inflow",
              counterparty: "Cliente",
              categoryId: "10000000-0000-4000-8000-000000000001",
              occurredAt: "2026-10-09T12:00:00.000Z",
            },
          },
        });
        expect(captured.status).toBe(201);
        const transaction = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
        )(yield* Effect.tryPromise(() => captured.json()));
        expect(
          (yield* call(
            db,
            owner,
            edit(2, {
              kind: "fulfill",
              fulfillment: {
                id: "40000000-0000-4000-8000-000000000125",
                planId,
                date: "2026-10-10",
                actualDate: "2026-10-10",
                money: planInput.money,
                settled: true,
                transactionId: transaction.data.id,
              },
            })
          )).status
        ).toBe(200);
        const once = yield* read(db, owner);
        expect(once.invalidFulfillmentIds).toEqual([]);
        expect(once.occurrences[0]?.status).toBe("completed");
        expect(
          (yield* call(
            db,
            owner,
            edit(3, { kind: "edit", planId, date: "2026-10-10", scope: "forward", plan: expense })
          )).status
        ).toBe(200);
        const forward = yield* read(db, owner);
        expect(forward.invalidFulfillmentIds).toEqual([]);
        expect(forward.occurrences[0]?.status).toBe("completed");
        expect(forward.occurrences[0]?.plan.kind).toBe("income");
      })
    ),
  30000
);

it(
  "retains an automatic completion moved across months when a competing plan is added",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        expect(
          (yield* call(
            db,
            owner,
            edit(0, { kind: "create", id: planId, plan: { ...planInput, firstDate: "2026-09-30" } })
          )).status
        ).toBe(200);
        expect(
          (yield* call(
            db,
            owner,
            edit(1, {
              kind: "edit",
              planId,
              date: "2026-09-30",
              scope: "once",
              plan: { ...planInput, firstDate: "2026-10-10" },
            })
          )).status
        ).toBe(200);
        const captured = yield* call(db, owner, {
          _tag: "Call",
          operation: CanonicalOperationId.make("transactions.createTransaction"),
          input: {
            payload: {
              money: planInput.money,
              direction: "outflow",
              counterparty: "Propietario",
              categoryId: "10000000-0000-4000-8000-000000000001",
              occurredAt: "2026-10-10T12:00:00.000Z",
            },
          },
        });
        expect(captured.status).toBe(201);
        const matched = yield* read(db, owner);
        expect(matched.occurrences.find((item) => item.date === "2026-09-30")?.status).toBe(
          "completed"
        );
        expect(matched.document.fulfillments).toEqual([]);
        expect(
          (yield* call(
            db,
            owner,
            edit(2, {
              kind: "create",
              id: "40000000-0000-4000-8000-000000000124",
              plan: { ...planInput, firstDate: "2026-10-10" },
            })
          )).status
        ).toBe(200);
        const competing = yield* read(db, owner);
        expect(competing.occurrences.find((item) => item.date === "2026-09-30")?.status).toBe(
          "completed"
        );
        expect(competing.occurrences.filter((item) => item.status === "completed")).toHaveLength(1);
        expect(competing.document.fulfillments[0]?.date).toBe("2026-09-30");
      })
    ),
  30000
);

it(
  "refuses foreign and absent suggestion references identically without changing either User's document",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        const other = Option.getOrThrow(Option.fromUndefinedOr(subjects[1]));
        const foreign = "40000000-0000-4000-8000-000000000131";
        const absent = "40000000-0000-4000-8000-000000000132";
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO recurring_series (user_id, id, currency, counterparty_key, series_json, evidence_json, reference_json, valid) VALUES (?, ?, 'COP', 'propietario', '{}', '{}', '{}', 1)"
            )
            .bind(other.userId, foreign)
            .run()
        );
        expect(
          (yield* call(db, owner, edit(0, { kind: "create", id: planId, plan: planInput }))).status
        ).toBe(200);
        const beforeOwner = (yield* read(db, owner)).document;
        const beforeOther = (yield* read(db, other)).document;
        for (const kind of ["create", "suggestion"]) {
          const bodies: string[] = [];
          for (const seriesId of [foreign, absent]) {
            const change =
              kind === "create"
                ? { kind, id: "40000000-0000-4000-8000-000000000124", plan: planInput, seriesId }
                : { kind, action: "link", planId, seriesId };
            const refused = yield* call(db, owner, edit(1, change));
            expect(refused.status).toBe(400);
            bodies.push(yield* Effect.tryPromise(() => refused.text()));
          }
          expect(bodies[0]).toEqual(bodies[1]);
        }
        expect((yield* read(db, owner)).document).toEqual(beforeOwner);
        expect((yield* read(db, other)).document).toEqual(beforeOther);
      })
    ),
  30000
);

it(
  "refuses foreign and absent Transaction associations identically without partial document effects",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        const other = Option.getOrThrow(Option.fromUndefinedOr(subjects[1]));
        const captured = yield* call(db, other, {
          _tag: "Call",
          operation: CanonicalOperationId.make("transactions.createTransaction"),
          input: {
            payload: {
              money: planInput.money,
              direction: "outflow",
              counterparty: "Propietario",
              categoryId: "10000000-0000-4000-8000-000000000001",
              occurredAt: "2026-10-10T12:00:00.000Z",
            },
          },
        });
        expect(captured.status).toBe(201);
        const transaction = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
        )(yield* Effect.tryPromise(() => captured.json()));
        expect(
          (yield* call(
            db,
            owner,
            edit(0, { kind: "create", id: planId, plan: { ...planInput, firstDate: "2026-10-11" } })
          )).status
        ).toBe(200);
        const beforeOwner = (yield* read(db, owner)).document;
        const beforeOther = (yield* read(db, other)).document;
        const bodies: string[] = [];
        for (const transactionId of [transaction.data.id, "40000000-0000-4000-8000-000000000141"]) {
          const response = yield* call(
            db,
            owner,
            edit(1, {
              kind: "fulfill",
              fulfillment: {
                id: "40000000-0000-4000-8000-000000000142",
                planId,
                date: "2026-10-11",
                actualDate: "2026-10-10",
                money: planInput.money,
                settled: true,
                transactionId,
              },
            })
          );
          expect(response.status).toBe(400);
          bodies.push(yield* Effect.tryPromise(() => response.text()));
        }
        expect(bodies[0]).toEqual(bodies[1]);
        expect((yield* read(db, owner)).document).toEqual(beforeOwner);
        expect((yield* read(db, other)).document).toEqual(beforeOther);
      })
    ),
  30000
);
it(
  "exposes incomplete earlier-month matching when the selected month's search is complete",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        expect(
          (yield* call(
            db,
            owner,
            edit(0, {
              kind: "create",
              id: planId,
              plan: { ...planInput, firstDate: "2026-09-10" },
            })
          )).status
        ).toBe(200);
        yield* Effect.tryPromise(() =>
          db.batch(
            Array.from({ length: 129 }, (_, index) =>
              db
                .prepare(
                  "INSERT INTO transactions (id,user_id,amount,currency,direction,category_id,occurred_at,created_at) VALUES (?,?,'1000','COP','outflow','10000000-0000-4000-8000-000000000001','2026-09-10T12:00:00.000Z',?)"
                )
                .bind(
                  `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
                  owner.userId,
                  index < 100 ? "2026-09-10T12:00:00.000Z" : "2026-09-11T12:00:00.000Z"
                )
            )
          )
        );
        const workspace = yield* read(db, owner);
        expect(workspace.occurrences).toHaveLength(1);
        expect(workspace.previous).toHaveLength(1);
        expect(workspace.matchesComplete).toBe(false);
      })
    ),
  30000
);

const seedReadBudget = (db: D1Database, current: number): Promise<D1Result> =>
  db
    .prepare(`WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
    INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
    SELECT 'read-budget-' || n, ?, ?, 'transactions.listTransactions', 'success', ? FROM seq`)
    .bind(dailyAuditBudget - 1, users[0], sessions[0], current)
    .run();
const readBudgetQuery = (
  db: D1Database,
  index: number,
  operation: "categories.listCategories" | "recurringPlans.getRecurringWorkspace"
): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.gen(function* () {
    const subject = {
      userId: users[index] ?? "",
      id: sessions[index] ?? "",
      digest: yield* Effect.tryPromise(() => digest(bearer(index))),
    };
    const result = yield* executeCanonicalQuery({
      db,
      subject,
      operation: CanonicalOperationId.make(operation),
      input: operation === "categories.listCategories" ? {} : { query: { month: "2026-10" } },
      bucket: Option.none(),
    });
    return Option.getOrThrow(result);
  });
const recoveryDatabase = (db: D1Database): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { bucket } = yield* Effect.tryPromise(() => recoveryStorage.acquire());
    yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
    return withErasureRecovery({
      DB: db,
      ERASURE_REQUIRED: "true",
      ERASURE_BUCKET: bucket,
    }).DB;
  });
const budgetReadOperations = [
  "categories.listCategories",
  "recurringPlans.getRecurringWorkspace",
] as const;
for (const previousDay of [false, true]) {
  it(
    `classifies exhausted read budgets without leaking storage errors (previous day: ${previousDay})`,
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* setup();
          const guarded = yield* recoveryDatabase(db);
          const current = yield* Clock.currentTimeMillis;
          yield* Effect.tryPromise(() =>
            seedReadBudget(db, current - (previousDay ? utcDayMilliseconds : 0))
          );
          for (const operation of budgetReadOperations) {
            const response = yield* readBudgetQuery(guarded, 0, operation);
            expect(response.status).toBe(previousDay ? 200 : 429);
            if (!previousDay) {
              const body = yield* Effect.tryPromise(() => response.text());
              expect(body).toContain('"code":"rate_limited"');
              expect(body).not.toContain("transaction_audit_limit");
              expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
              expect(response.headers.get("cache-control")).toBe("no-store");
            }
            expect((yield* readBudgetQuery(guarded, 1, operation)).status).toBe(200);
          }
          expect(
            yield* Effect.tryPromise(() => dailyAuditCount({ db, userId: users[0] ?? "", current }))
          ).toBe(previousDay ? budgetReadOperations.length : dailyAuditBudget);
        })
      ),
    30000
  );
}
it(
  "keeps unrelated read storage failures unavailable",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* Effect.tryPromise(() => db.prepare("DROP TABLE category_audit").run());
        const guarded = yield* recoveryDatabase(db);
        for (const operation of budgetReadOperations) {
          const response = yield* readBudgetQuery(guarded, 0, operation);
          expect(response.status).toBe(503);
          const body = yield* Effect.tryPromise(() => response.text());
          expect(body).not.toContain("category_audit");
          expect(body).not.toContain("D1_ERROR");
        }
      })
    ),
  30000
);
