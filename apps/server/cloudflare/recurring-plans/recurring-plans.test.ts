import { type CanonicalWork } from "../canonical-operations/contract";
import { type QueryCaller } from "../canonical-work/operations";
import { Cause, Config, DateTime, Effect, Option, Schema } from "effect";
import { RecurringDocument } from "../../src/core/recurring-plans/contract";
import { withErasureRecovery } from "../erasure/runtime";
import {
  documentedSqlBlock,
  installHistoricalErasureStorage,
} from "../schema-cutover.test-fixture";
import { RecurringWorkspace } from "../../src/shell/recurring-plans/contract";
import {
  installTestSchema,
  isolatedTestDatabases,
  isolatedTestStorage,
  observeRetentionCost,
} from "../d1-test-fixture";
import { executeCanonicalQuery, executeCanonicalWork } from "../canonical-operations/operations";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import { UserId } from "../../src/core/identity/contract";
import { RecurringSeriesPage } from "../../src/core/recurring/contract";
import { evaluateRecurringSeries } from "../recurring/operations";
import { afterAll, expect, it } from "vitest";

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
    yield* Effect.tryPromise(() => installTestSchema({ db }));
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
const edit = (revision: number, change: object, view?: "compact"): CanonicalWork => ({
  _tag: "Call",
  operation: CanonicalOperationId.make("recurringPlans.applyRecurringEdit"),
  input: {
    payload: { expectedRevision: revision, edit: change, ...(view === undefined ? {} : { view }) },
  },
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

it("reads an empty recurring workspace without scanning Transaction matching facts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, subjects } = yield* fixture();
      const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
      const observed = observeRetentionCost(db);
      const workspace = yield* read(observed.database, owner);
      expect(workspace.document.plans).toEqual([]);
      expect(workspace.occurrences).toEqual([]);
      expect(workspace.previous).toEqual([]);
      expect(workspace.matches).toEqual([]);
      expect(workspace.matchesComplete).toBe(true);
      expect(
        observed
          .statements()
          .filter(({ sql }) => sql.includes("occurred_at_ms >= ? AND occurred_at_ms < ?"))
      ).toHaveLength(0);
    })
  ));

it("compact recurring responses preserve stored history and historical occurrence settings", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, subjects } = yield* fixture();
      const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
      const first = { ...planInput, firstDate: "2026-09-01" };
      expect(
        (yield* call(db, owner, edit(0, { kind: "create", id: planId, plan: first }))).status
      ).toBe(200);
      const changed = yield* call(
        db,
        owner,
        edit(
          1,
          {
            kind: "edit",
            planId,
            date: "2026-10-01",
            scope: "forward",
            plan: { ...first, firstDate: "2026-10-01", name: "Nuevo" },
          },
          "compact"
        )
      );
      expect(changed.status).toBe(200);
      const receipt = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.toCodecJson(RecurringDocument) })
      )(yield* Effect.tryPromise(() => changed.json()));
      expect(receipt.data.plans[0]?.revisions).toHaveLength(1);
      expect((yield* read(db, owner)).document.plans[0]?.revisions).toHaveLength(2);
      const selected = yield* executeCanonicalQuery({
        db,
        subject: owner,
        operation: CanonicalOperationId.make("recurringPlans.getRecurringWorkspace"),
        input: { query: { month: "2026-09", view: "compact" } },
        bucket: Option.none(),
      });
      const response = Option.getOrThrow(selected);
      expect(response.status).toBe(200);
      const workspace = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.toCodecJson(RecurringWorkspace) })
      )(yield* Effect.tryPromise(() => response.json()));
      expect(workspace.data.document.plans[0]?.revisions).toHaveLength(1);
      expect(workspace.data.document.plans[0]?.revisions[0].plan.name).toBe("Nuevo");
      expect(workspace.data.occurrences[0]?.plan.name).toBe("Arriendo");
    })
  ));

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
              "INSERT INTO consent_history (record_type,id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, occurred_at_ms) VALUES ('processing_grant',?, ?, '{}', 'disclosure', 'decision', 0, 0)"
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
        expect(matched.matchesComplete).toBe(true);
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
              "CREATE TRIGGER recurring_test_audit_failure BEFORE INSERT ON audit_entries WHEN NEW.record_type='credential_call' AND NEW.operation = 'recurringPlans.applyRecurringEdit' AND NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'test unavailable'); END"
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
                  "INSERT INTO transactions (id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES (?,?,'1000','COP','outflow','10000000-0000-4000-8000-000000000001',1789041600000,CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER))"
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

it("keeps two complete matching ranges above 128 combined facts and excludes another User's facts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, subjects } = yield* fixture();
      const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
      const other = Option.getOrThrow(Option.fromUndefinedOr(subjects[1]));
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
          Array.from({ length: 329 }, (_, index) =>
            db
              .prepare(
                "INSERT INTO transactions (id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES (?,?,'1000','COP','outflow','10000000-0000-4000-8000-000000000001',?,?)"
              )
              .bind(
                `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
                index < 200 ? owner.userId : other.userId,
                DateTime.toEpochMillis(
                  DateTime.makeUnsafe(
                    index < 100 ? "2026-09-10T12:00:00.000Z" : "2026-10-10T12:00:00.000Z"
                  )
                ),
                DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-29T12:00:00.000Z"))
              )
          )
        )
      );
      const workspace = yield* read(db, owner);
      expect(workspace.occurrences).toHaveLength(1);
      expect(workspace.previous).toHaveLength(1);
      expect(workspace.matchesComplete).toBe(true);
    })
  ));

const readQuery = (
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
const readOperations = [
  "categories.listCategories",
  "recurringPlans.getRecurringWorkspace",
] as const;
it(
  "keeps unrelated read storage failures unavailable",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* Effect.tryPromise(() => db.prepare("DROP TABLE audit_entries").run());
        const guarded = yield* recoveryDatabase(db);
        for (const operation of readOperations) {
          const response = yield* readQuery(guarded, 0, operation);
          expect(response.status).toBe(503);
          const body = yield* Effect.tryPromise(() => response.text());
          expect(body).not.toContain("audit_entries");
          expect(body).not.toContain("audit_entries");
          expect(body).not.toContain("D1_ERROR");
        }
      })
    ),
  30000
);

it(
  "keeps supported large Planning history readable and isolates concurrent edits",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        const root = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          excludedTransactionIds: Array.from(
            { length: 4096 },
            (_, index) => `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`
          ),
          suggestions: Array.from({ length: 4096 }, (_, index) => ({
            seriesId: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            disposition: "linked",
            planId: "40000000-0000-4000-8000-000000000000",
          })),
        });
        yield* Effect.tryPromise(() =>
          db
            .prepare("INSERT INTO user_documents VALUES(?,'recurring-plan',?,10000)")
            .bind(owner.userId, root)
            .run()
        );
        for (let plan = 0; plan < 100; plan++) {
          const id = `40000000-0000-4000-8000-${String(plan).padStart(12, "0")}`;
          const revisions = Array.from({ length: 100 }, (_, index) => ({
            from: DateTime.formatIsoDateUtc(
              DateTime.add(DateTime.makeUnsafe("2026-01-01"), { months: index })
            ),
            plan: {
              ...planInput,
              firstDate: "2026-01-01",
              name: `Plan ${plan}, revision ${index}`.padEnd(120, "x"),
              counterparty: "x".repeat(120),
            },
          }));
          const encodedRevisions = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown)
          )(revisions);
          yield* Effect.tryPromise(() =>
            db.batch([
              db
                .prepare(
                  "INSERT INTO recurring_plans(user_id,id,position,pauses_json) VALUES(?,?,?,'[]')"
                )
                .bind(owner.userId, id, plan),
              db
                .prepare(
                  "INSERT INTO recurring_plan_revisions(user_id,plan_id,position,from_date,plan_json) SELECT ?,?,CAST(key AS INTEGER),json_extract(value,'$.from'),json_extract(value,'$.plan') FROM json_each(?)"
                )
                .bind(owner.userId, id, encodedRevisions),
            ])
          );
        }
        const exceptions = Array.from({ length: 4096 }, (_, index) => ({
          planId: `40000000-0000-4000-8000-${String(index % 100).padStart(12, "0")}`,
          date: DateTime.formatIsoDateUtc(
            DateTime.add(DateTime.makeUnsafe("2040-01-01"), { months: Math.floor(index / 100) })
          ),
          skipped: true,
        }));
        const fulfillments = Array.from({ length: 4096 }, (_, index) => ({
          id: `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          planId: `40000000-0000-4000-8000-${String(index % 100).padStart(12, "0")}`,
          date: DateTime.formatIsoDateUtc(
            DateTime.add(DateTime.makeUnsafe("2050-01-01"), { months: Math.floor(index / 100) })
          ),
          money: { amount: "1000000", currency: "COP" },
        }));
        const pauses = Array.from({ length: 100 }, (_, index) => ({
          from: DateTime.formatIsoDateUtc(
            DateTime.add(DateTime.makeUnsafe("2090-01-01"), { days: index })
          ),
          through: DateTime.formatIsoDateUtc(
            DateTime.add(DateTime.makeUnsafe("2090-01-01"), { days: index })
          ),
        }));
        const encodedExceptions = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          exceptions
        );
        const encodedFulfillments = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown)
        )(fulfillments);
        const encodedPauses = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          pauses
        );
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO recurring_plan_exceptions(user_id,plan_id,position,local_date,skipped) SELECT ?,json_extract(value,'$.planId'),CAST(key AS INTEGER),json_extract(value,'$.date'),1 FROM json_each(?)"
              )
              .bind(owner.userId, encodedExceptions),
            db
              .prepare(
                "INSERT INTO recurring_plan_fulfillments(user_id,id,plan_id,position,local_date,actual_date,amount,currency,settled) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.planId'),CAST(key AS INTEGER),json_extract(value,'$.date'),json_extract(value,'$.date'),json_extract(value,'$.money.amount'),json_extract(value,'$.money.currency'),1 FROM json_each(?)"
              )
              .bind(owner.userId, encodedFulfillments),
            db
              .prepare("UPDATE recurring_plans SET pauses_json=? WHERE user_id=?")
              .bind(encodedPauses, owner.userId),
          ])
        );
        const workspace = yield* read(db, owner);
        expect(workspace.document.excludedTransactionIds).toHaveLength(4096);
        expect(workspace.document.suggestions).toHaveLength(4096);
        expect(workspace.document.exceptions).toHaveLength(4096);
        expect(workspace.document.fulfillments).toHaveLength(4096);
        expect(workspace.document.plans[0]?.pauses).toHaveLength(100);
        if (measureStorage) {
          const payload = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.toCodecJson(RecurringDocument))
          )(workspace.document);
          const observation = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            documentBytes: new TextEncoder().encode(payload).length,
            rootBytes: new TextEncoder().encode(root).length,
            plans: 100,
            revisionsPerPlan: 100,
            pausesPerPlan: 100,
            exceptions: 4096,
            fulfillments: 4096,
            exclusions: 4096,
            suggestions: 4096,
          });
          yield* Effect.sync(() => process.stdout.write(`PLANNING_CAPACITY ${observation}\n`));
        }
        expect(workspace.document.plans).toHaveLength(100);
        expect(workspace.document.plans[99]?.revisions).toHaveLength(100);
        expect(workspace.document.plans[99]?.revisions[99]?.plan.name).toBe(
          "Plan 99, revision 99".padEnd(120, "x")
        );
        const foreign = Option.getOrThrow(Option.fromUndefinedOr(subjects[1]));
        expect((yield* read(db, foreign)).document.revision).toBe(0);
        const cost = yield* measurePlanningContention(db, owner, {
          revision: 10000,
          date: "2043-05-01",
          planId: "40000000-0000-4000-8000-000000000095",
        });
        expect(cost.rowsWritten).toBeLessThan(100);
        expect((yield* read(db, owner)).document.plans[99]?.revisions).toHaveLength(100);
      })
    ),
  60000
);

const seedPlanningHistory = Effect.fn(function* (
  db: D1Database,
  userId: string,
  document: typeof RecurringDocument.Encoded
) {
  const root = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    excludedTransactionIds: document.excludedTransactionIds,
    suggestions: document.suggestions,
  });
  yield* Effect.tryPromise(() =>
    db
      .prepare("INSERT INTO user_documents VALUES(?,'recurring-plan',?,?)")
      .bind(userId, root, document.revision)
      .run()
  );
  for (const [position, plan] of document.plans.entries()) {
    const revisions = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      plan.revisions
    );
    const pauses = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(plan.pauses);
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO recurring_plans(user_id,id,position,pauses_json,stopped_on) VALUES(?,?,?,?,?)"
          )
          .bind(userId, plan.id, position, pauses, plan.stoppedOn ?? null),
        db
          .prepare(
            "INSERT INTO recurring_plan_revisions(user_id,plan_id,position,from_date,plan_json) SELECT ?,?,CAST(key AS INTEGER),json_extract(value,'$.from'),json_extract(value,'$.plan') FROM json_each(?)"
          )
          .bind(userId, plan.id, revisions),
      ])
    );
  }
});

const measurePlanningContention = Effect.fn(function* (
  db: D1Database,
  owner: QueryCaller,
  { revision, date, planId }: Readonly<{ revision: number; date: string; planId: string }>
) {
  const observed = observeRetentionCost(db);
  const started = performance.now();
  const replies = yield* Effect.forEach(
    [1, 2],
    () =>
      call(
        observed.database,
        owner,
        edit(revision, {
          kind: "skip",
          planId,
          date,
          skipped: false,
        })
      ),
    { concurrency: "unbounded" }
  );
  const elapsedMs = performance.now() - started;
  const statuses = replies.map((reply) => reply.status).sort((left, right) => left - right);
  expect(statuses[0]).toBe(200);
  expect([400, 503]).toContain(statuses[1]);
  expect((yield* read(db, owner)).document.revision).toBe(revision + 1);
  return { ...observed.cost(), elapsedMs, outcomes: statuses.join(",") };
});
const nativeStorageFailure = (error: Cause.UnknownError): string =>
  /SQLITE_TOOBIG/u.test(Cause.pretty(Cause.fail(error))) ? "SQLITE_TOOBIG" : "OTHER_NATIVE_FAILURE";
const measureStorage =
  Effect.runSync(Config.String("INFRA_PERFORMANCE_MEASURE").pipe(Config.withDefault("0"))) === "1";
it.skipIf(!measureStorage)(
  "compares document limits with relational Planning history and concurrent edits",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const revisions of [1, 25, 100]) {
          const { db, subjects } = yield* fixture();
          const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
          const input = {
            revision: 100 * revisions,
            plans: Array.from({ length: 100 }, (_, plan) => ({
              id: `40000000-0000-4000-8000-${String(plan).padStart(12, "0")}`,
              revisions: Array.from({ length: revisions }, (_, revision) => {
                const date = DateTime.formatIsoDateUtc(
                  DateTime.add(DateTime.makeUnsafe("2026-01-01"), { months: revision })
                );
                return {
                  from: date,
                  plan: {
                    ...planInput,
                    name: `Plan ${plan}, revision ${revision}`.padEnd(120, "x"),
                    counterparty: `Counterparty ${plan}`.padEnd(120, "x"),
                    firstDate: date,
                  },
                };
              }),
              pauses: [],
            })),
            exceptions: [],
            fulfillments: [],
            excludedTransactionIds: [],
            suggestions: [],
          };
          const document = yield* Schema.decodeEffect(Schema.toCodecJson(RecurringDocument))(input);
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.toCodecJson(RecurringDocument))
          )(document);
          const { revision: _revision, ...payload } = input;
          const withoutRevision = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            payload
          );
          const started = performance.now();
          const stored = yield* Effect.result(
            Effect.tryPromise(() =>
              db
                .prepare(
                  "INSERT INTO user_documents(user_id,kind,document_json,revision) VALUES(?,'recurring-plan',?,?)"
                )
                .bind(owner.userId, encoded, document.revision)
                .run()
            )
          );
          const elapsed = performance.now() - started;
          const fits = new TextEncoder().encode(withoutRevision).length < 2_000_000;
          let readMs = -1;
          let raceMs = -1;
          let raceReads = 0;
          let raceWrites = 0;
          let outcomes = "not-run";
          const failure = stored._tag === "Failure" ? nativeStorageFailure(stored.failure) : "";
          expect(failure).toBe(fits ? "" : "SQLITE_TOOBIG");
          if (stored._tag === "Success") {
            yield* Effect.tryPromise(() =>
              db
                .prepare("DELETE FROM user_documents WHERE user_id=? AND kind='recurring-plan'")
                .bind(owner.userId)
                .run()
            );
          }
          const relationalStarted = performance.now();
          yield* seedPlanningHistory(
            db,
            owner.userId,
            yield* Schema.encodeEffect(RecurringDocument)(document)
          );
          const relationalWriteMs = performance.now() - relationalStarted;
          const readStart = performance.now();
          const workspace = yield* read(db, owner);
          readMs = performance.now() - readStart;
          expect(workspace.document.plans).toHaveLength(100);
          expect(workspace.document.plans[99]?.revisions).toHaveLength(revisions);
          const race = yield* measurePlanningContention(db, owner, {
            revision: document.revision,
            date: "2026-01-01",
            planId: "40000000-0000-4000-8000-000000000000",
          });
          raceMs = race.elapsedMs;
          raceReads = race.rowsRead;
          raceWrites = race.rowsWritten;
          outcomes = race.outcomes;
          const observation = yield* Schema.encodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                plans: Schema.Int,
                revisions: Schema.Int,
                bytes: Schema.Int,
                bytesWithoutRevision: Schema.Int,
                fitsD1ValueLimit: Schema.Boolean,
                nativeStored: Schema.Boolean,
                relationalWriteMs: Schema.Finite,
                writeMs: Schema.Finite,
                publicReadMs: Schema.Finite,
                concurrentEditMs: Schema.Finite,
                concurrentRowsRead: Schema.Int,
                concurrentRowsWritten: Schema.Int,
                nativeFailure: Schema.String,
                concurrentOutcomes: Schema.String,
              })
            )
          )({
            plans: 100,
            revisions,
            bytes: new TextEncoder().encode(encoded).length,
            bytesWithoutRevision: new TextEncoder().encode(withoutRevision).length,
            fitsD1ValueLimit: fits,
            nativeStored: stored._tag === "Success",
            relationalWriteMs,
            writeMs: elapsed,
            publicReadMs: readMs,
            concurrentEditMs: raceMs,
            concurrentRowsRead: raceReads,
            concurrentRowsWritten: raceWrites,
            nativeFailure: failure,
            concurrentOutcomes: outcomes,
          });
          yield* Effect.sync(() => process.stdout.write(`PLANNING_STORAGE ${observation}\n`));
        }
      })
    ),
  60_000
);

it(
  "converts populated Planning state atomically and reconstructs the original representation for rollback",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        yield* Effect.tryPromise(() => installHistoricalErasureStorage(db));
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        const legacy = {
          revision: 8,
          plans: [
            {
              id: planId,
              pauses: [{ from: "2026-10-05", through: "2026-10-08" }],
              stoppedOn: "2027-01-01",
              revisions: [
                {
                  from: "2026-10-01",
                  plan: {
                    ...planInput,
                    firstDate: "2026-10-01",
                    money: { amount: "1000000000000000000000000.01", currency: "COP" },
                  },
                },
                { from: "2026-11-01", plan: planInput },
              ],
            },
          ],
          exceptions: [
            { planId, date: "2026-10-01", skipped: false, replacement: planInput },
            { planId, date: "2026-12-31", skipped: true },
          ],
          fulfillments: [
            {
              id: "40000000-0000-4000-8000-000000000141",
              planId,
              date: "2026-10-01",
              actualDate: "2026-10-01",
              money: { amount: "100.01", currency: "COP" },
              settled: false,
              automatic: false,
            },
            {
              id: "40000000-0000-4000-8000-000000000142",
              planId,
              date: "2026-11-30",
              actualDate: "2026-11-30",
              money: { amount: "1000000", currency: "COP" },
              settled: true,
            },
          ],
          excludedTransactionIds: ["40000000-0000-4000-8000-000000000143"],
          suggestions: [
            { seriesId: "40000000-0000-4000-8000-000000000144", disposition: "dismissed" },
          ],
        };
        const codec = Schema.fromJsonString(Schema.toCodecJson(RecurringDocument));
        const original = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(RecurringDocument))(
          legacy
        );
        const encoded = yield* Schema.encodeEffect(codec)(original);
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO user_documents(rowid,user_id,kind,document_json,revision) VALUES(17,?,'recurring-plan',?,8)"
              )
              .bind(owner.userId, encoded),
            db
              .prepare(
                "INSERT INTO user_documents(rowid,user_id,kind,document_json,revision) VALUES(19,?,'dashboard','{}',3)"
              )
              .bind(owner.userId),
          ])
        );
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (marker: string): ReadonlyArray<D1PreparedStatement> =>
          documentedSqlBlock({ guide, marker: "recurring-planning-" + marker }).map((sql) =>
            db.prepare(sql)
          );
        const pending = yield* executeCanonicalQuery({
          db,
          subject: owner,
          operation: CanonicalOperationId.make("recurringPlans.getRecurringWorkspace"),
          input: { query: { month: "2026-10" } },
          bucket: Option.none(),
        });
        expect(Option.getOrThrow(pending).status).toBe(503);
        const before = yield* Effect.tryPromise(() =>
          db.prepare("SELECT rowid,* FROM user_documents ORDER BY rowid").all()
        );
        const failed = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              ...block("copy"),
              db.prepare("INSERT INTO sql_assertions VALUES('intentional_failure',0)"),
            ])
          )
        );
        expect(failed._tag).toBe("Failure");
        expect(
          (yield* Effect.tryPromise(() =>
            db.prepare("SELECT rowid,* FROM user_documents ORDER BY rowid").all()
          )).results
        ).toEqual(before.results);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS n FROM recurring_plans").first("n")
          )
        ).toBe(0);
        yield* Effect.tryPromise(() => db.batch([...block("copy")]));
        expect((yield* read(db, owner)).document).toEqual(original);
        expect(
          (yield* read(db, Option.getOrThrow(Option.fromUndefinedOr(subjects[1])))).document
            .revision
        ).toBe(0);
        yield* Effect.tryPromise(() => db.batch([...block("rollback")]));
        const restored = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT document_json FROM user_documents WHERE rowid=17")
            .first<string>("document_json")
        );
        expect(yield* Schema.decodeUnknownEffect(codec)(restored)).toEqual(original);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT rowid,revision,document_json FROM user_documents WHERE kind='dashboard'"
              )
              .first()
          )
        ).toEqual({ rowid: 19, revision: 3, document_json: "{}" });
        yield* Effect.tryPromise(() => db.batch([...block("copy")]));
        expect((yield* read(db, owner)).document).toEqual(original);
      })
    ),
  30000
);

it.each(["revision", "duplicate", "foreign-parent", "archive"])(
  "refuses inconsistent or retained Planning conversion without partial effects: %s",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, subjects } = yield* fixture();
        yield* Effect.tryPromise(() => installHistoricalErasureStorage(db));
        const owner = Option.getOrThrow(Option.fromUndefinedOr(subjects[0]));
        const plan = {
          id: planId,
          revisions: [{ from: "2026-10-31", plan: planInput }],
          pauses: [],
        };
        const value = {
          revision: failure === "revision" ? 2 : 1,
          plans: failure === "duplicate" ? [plan, plan] : [plan],
          exceptions:
            failure === "foreign-parent"
              ? [
                  {
                    planId: "40000000-0000-4000-8000-000000000999",
                    date: "2026-10-31",
                    skipped: true,
                  },
                ]
              : [],
          fulfillments: [],
          excludedTransactionIds: [],
          suggestions: [],
        };
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value);
        yield* Effect.tryPromise(() =>
          db
            .prepare("INSERT INTO user_documents VALUES(?,'recurring-plan',?,1)")
            .bind(owner.userId, encoded)
            .run()
        );
        if (failure === "archive") {
          yield* Effect.tryPromise(() =>
            db.batch([
              db.prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('prior','deleted',1,'Complete')"
              ),
              db.prepare(
                "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES('prior','recurring_plan_documents','initial:17','{}')"
              ),
            ])
          );
        }
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const statements = documentedSqlBlock({ guide, marker: "recurring-planning-copy" }).map(
          (sql) => db.prepare(sql)
        );
        expect((yield* Effect.result(Effect.tryPromise(() => db.batch(statements))))._tag).toBe(
          "Failure"
        );
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT document_json FROM user_documents WHERE user_id=?")
              .bind(owner.userId)
              .first("document_json")
          )
        ).toBe(encoded);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS n FROM recurring_plans").first("n")
          )
        ).toBe(0);
      })
    ),
  30000
);
