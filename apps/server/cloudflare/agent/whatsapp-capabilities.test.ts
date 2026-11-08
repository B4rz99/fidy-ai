import { decideOperationAccess } from "../../src/shell/canonical-policy/operations";
import {
  installedCanonicalOperations,
  installedHostedStatementOperations,
} from "../canonical-operations/operations";
import { generateInsight } from "../insights/operations";
import { InsightGenerationInput } from "../../src/core/insights/contract";
import { UserId } from "../../src/core/identity/contract";
import { DateTime, Effect, Option, Schema } from "effect";
import { expect, it } from "vitest";
import { setup as baseSetup, now, users } from "./hosted-turn.test-fixture";
import { seedPaidCardSubscription } from "../subscription/refund-charge.test-fixture";
import { SubscriptionStatus } from "../../src/core/subscription/contract";
import {
  exerciseTurn,
  runCapability,
  seedReviewItem,
  successfulCapability,
  toolReply,
} from "./whatsapp-capabilities.test-fixture";

const setup = (): Promise<D1Database> =>
  baseSetup().then((db) => {
    const current = now();
    return db
      .prepare("UPDATE users SET trial_started_at_ms=?,trial_ends_at_ms=? WHERE id=?")
      .bind(current, current + 604800000, users[0])
      .run()
      .then(() => db);
  });

it("installs every canonical operation allowed for verified WhatsApp and excludes forbidden policies", () => {
  const caller = { _tag: "HostedAgentSession", authorityRoot: "verified-whatsapp" } as const;
  const eligible = installedCanonicalOperations().filter(
    ({ policy }) => decideOperationAccess(policy.access, caller)._tag === "Allowed"
  );
  const installed = installedHostedStatementOperations();
  expect(installed.map(({ id }) => id)).toEqual(
    expect.arrayContaining(eligible.map(({ id }) => id))
  );
  expect(
    installed.every(({ policy }) => decideOperationAccess(policy.access, caller)._tag === "Allowed")
  ).toBe(true);
});

it("creates a Budget through an admitted WhatsApp Turn with an attributable durable result", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const result = yield* exerciseTurn({
        db,
        text: "Crea un presupuesto de 100000 COP para Otros",
        messageId: "wamid.capability-budget-create",
        generate: () =>
          Promise.resolve(
            toolReply({
              operation: "budgets.createBudget",
              input: {
                payload: {
                  categoryId: "10000000-0000-4000-8000-000000000016",
                  cap: { amount: "100000", currency: "COP" },
                },
              },
            })
          ),
      });
      expect(result.sent).toHaveLength(1);
      expect(result.sent[0]).toBe("Listo, apliqué los cambios.");
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM budgets").first<number>("count")
        )
      ).toBe(1);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT operation FROM audit_entries WHERE hosted_turn_id=?")
            .bind(result.turnId)
            .first<string>("operation")
        )
      ).toBe("budgets.createBudget");
    })
  ));

const emptyQueries = [
  { operation: "categories.listCategories", input: {} },
  { operation: "categories.listKeywordRules", input: {} },
  { operation: "budgets.listBudgets", input: {} },
  {
    operation: "budgets.getBudgetStatus",
    input: { query: { month: "2026-11", timeZone: "America/Bogota" } },
  },
  { operation: "connections.listInstitutions", input: {} },
  { operation: "connections.listConnections", input: {} },
  { operation: "dashboard.listDashboardCatalog", input: {} },
  { operation: "ingestion.getReviewWorkspace", input: { query: {} } },
  { operation: "insights.listPendingInsights", input: { query: {} } },
  { operation: "recurring.listRecurringSeries", input: { query: {} } },
  { operation: "recurringPlans.getRecurringWorkspace", input: { query: { month: "2026-11" } } },
  { operation: "memory.recall", input: {} },
  { operation: "subscription.getUpgradeUrl", input: {} },
  { operation: "subscription.listSubscriptionOffers", input: {} },
  { operation: "subscription.getSubscriptionStatus", input: {} },
  { operation: "quota.getQuota", input: {} },
  { operation: "pats.listPATs", input: {} },
] as const;
it.each(emptyQueries)(
  "answers $operation through the WhatsApp owner and records the admitted Turn",
  ({ operation, input }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        const output = yield* successfulCapability({ db, operation, input });
        expect(output).toHaveProperty("data");
      })
    )
);

it("creates, reads, changes and deletes a WhatsApp Budget using canonical persisted state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const created = yield* successfulCapability({
        db,
        operation: "budgets.createBudget",
        input: {
          payload: {
            categoryId: "10000000-0000-4000-8000-000000000016",
            cap: { amount: "100000", currency: "COP" },
          },
        },
      });
      const {
        data: { id },
      } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
      )(created);
      expect(
        yield* successfulCapability({
          db,
          operation: "budgets.getBudget",
          input: { params: { id } },
        })
      ).toMatchObject({ data: { id, cap: { amount: "100000", currency: "COP" } } });
      yield* successfulCapability({
        db,
        operation: "budgets.updateBudget",
        input: {
          params: { id },
          payload: {
            categoryId: "10000000-0000-4000-8000-000000000016",
            cap: { amount: "150000", currency: "COP" },
          },
        },
      });
      expect(
        yield* successfulCapability({ db, operation: "budgets.listBudgets", input: {} })
      ).toMatchObject({ data: [{ id, cap: { amount: "150000", currency: "COP" } }] });
      yield* successfulCapability({
        db,
        operation: "budgets.deleteBudget",
        input: { params: { id } },
      });
      expect(
        yield* successfulCapability({ db, operation: "budgets.listBudgets", input: {} })
      ).toMatchObject({ data: [] });
    })
  ));

it("creates, revises and forgets explicit Memory through confirmed WhatsApp operations", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const created = yield* successfulCapability({
        db,
        operation: "memory.remember",
        input: { payload: { text: "Prefiero resúmenes breves." } },
      });
      const {
        data: { id },
      } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
      )(created);
      yield* successfulCapability({
        db,
        operation: "memory.revise",
        input: { params: { id }, payload: { text: "Prefiero resúmenes detallados." } },
      });
      expect(
        yield* successfulCapability({ db, operation: "memory.recall", input: {} })
      ).toMatchObject({ data: [{ id, text: "Prefiero resúmenes detallados." }] });
      yield* successfulCapability({ db, operation: "memory.forget", input: { params: { id } } });
      expect(
        yield* successfulCapability({ db, operation: "memory.recall", input: {} })
      ).toMatchObject({ data: [] });
    })
  ));

it("creates, updates and deletes a future-capture keyword rule through WhatsApp", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const created = yield* successfulCapability({
        db,
        operation: "categories.createKeywordRule",
        input: {
          payload: { keyword: "qa-cafe", categoryId: "10000000-0000-4000-8000-000000000016" },
        },
      });
      const {
        data: { id },
      } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
      )(created);
      yield* successfulCapability({
        db,
        operation: "categories.updateKeywordRule",
        input: {
          params: { id },
          payload: { keyword: "qa-mercado", categoryId: "10000000-0000-4000-8000-000000000016" },
        },
      });
      expect(
        yield* successfulCapability({ db, operation: "categories.listKeywordRules", input: {} })
      ).toMatchObject({ data: [{ id, keyword: "qa-mercado" }] });
      yield* successfulCapability({
        db,
        operation: "categories.deleteKeywordRule",
        input: { params: { id } },
      });
      expect(
        yield* successfulCapability({ db, operation: "categories.listKeywordRules", input: {} })
      ).toMatchObject({ data: [] });
    })
  ));

it("initializes a Dashboard, changes its title and reads both canonical projections through WhatsApp", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* successfulCapability({ db, operation: "dashboard.initializeDashboard", input: {} });
      yield* successfulCapability({
        db,
        operation: "dashboard.applyDashboardEdit",
        input: { payload: { op: "set-title", title: "QA WhatsApp" } },
      });
      expect(
        yield* successfulCapability({ db, operation: "dashboard.getDashboard", input: {} })
      ).toMatchObject({ data: { title: "QA WhatsApp" } });
      expect(
        yield* successfulCapability({ db, operation: "dashboard.getDashboardView", input: {} })
      ).toMatchObject({ data: { title: "QA WhatsApp" } });
    })
  ));

it("creates and retrieves a RecurringPlan through confirmed WhatsApp execution", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const id = "40000000-0000-4000-8000-000000000123";
      yield* successfulCapability({
        db,
        operation: "recurringPlans.applyRecurringEdit",
        input: {
          payload: {
            expectedRevision: 0,
            edit: {
              kind: "create",
              id,
              plan: {
                name: "Arriendo QA",
                kind: "expense",
                currency: "COP",
                amountMode: "fixed",
                money: { amount: "1000000", currency: "COP" },
                firstDate: "2026-11-15",
                timeZone: "America/Bogota",
                frequency: "monthly",
              },
            },
          },
        },
      });
      expect(
        yield* successfulCapability({
          db,
          operation: "recurringPlans.getRecurringWorkspace",
          input: { query: { month: "2026-11" } },
        })
      ).toMatchObject({
        data: { document: { revision: 1, plans: [{ id }] } },
      });
    })
  ));

it("enables and retrieves the same email-forwarding address through WhatsApp", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const created = yield* successfulCapability({
        db,
        operation: "ingestion.enableEmailForwarding",
        input: {},
      });
      const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ data: Schema.Unknown }))(
        created
      );
      expect(
        yield* successfulCapability({ db, operation: "ingestion.getEmailForwarding", input: {} })
      ).toMatchObject({ data: { address: address.data } });
    })
  ));

it("confirms an atomic cross-owner batch and exposes both committed effects through WhatsApp", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* successfulCapability({
        db,
        operation: "operations.executeAtomicBatch",
        input: {
          payload: {
            calls: [
              {
                callId: "70000000-0000-4000-8000-000000000001",
                operation: "budgets.createBudget",
                input: {
                  payload: {
                    categoryId: "10000000-0000-4000-8000-000000000016",
                    cap: { amount: "99000", currency: "COP" },
                  },
                },
              },
              {
                callId: "70000000-0000-4000-8000-000000000002",
                operation: "memory.remember",
                input: { payload: { text: "QA batch" } },
              },
            ],
          },
        },
      });
      expect(
        yield* successfulCapability({ db, operation: "budgets.listBudgets", input: {} })
      ).toMatchObject({ data: [{ cap: { amount: "99000", currency: "COP" } }] });
      expect(
        yield* successfulCapability({ db, operation: "memory.recall", input: {} })
      ).toMatchObject({ data: [{ text: "QA batch" }] });
    })
  ));

it.each([
  {
    operation: "connections.getConnection",
    input: { params: { id: "80000000-0000-4000-8000-000000000001" } },
  },
  {
    operation: "connections.listAccounts",
    input: { params: { id: "80000000-0000-4000-8000-000000000001" } },
  },
  {
    operation: "connections.connectInstitution",
    input: { payload: { institutionId: "bancolombia" } },
  },
])(
  "returns the canonical refusal for $operation when no eligible resource exists",
  ({ operation, input }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        const result = yield* runCapability({ db, operation, input });
        expect(result.outcome).toMatchObject({
          _tag: "CanonicalOperationFailed",
          failure: {
            error: {
              code:
                operation === "connections.connectInstitution" ? "validation_failed" : "not_found",
            },
          },
        });
      })
    )
);

it("cancels paid access through exact confirmation and explains an already cancelled renewal without another approval", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => baseSetup());
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE users SET trial_started_at_ms=0,trial_ends_at_ms=604800000 WHERE id=?")
          .bind(users[0])
          .run()
      );
      yield* seedPaidCardSubscription({ db, userId: users[0] });
      const standing = Effect.fnUntraced(function* () {
        return yield* successfulCapability({
          db,
          operation: "subscription.getSubscriptionStatus",
          input: {},
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({ data: Schema.toCodecJson(SubscriptionStatus) })
            )
          )
        );
      });
      const before = yield* standing();
      expect(before.data.accessTier).toBe("pro");
      expect(before.data.hasProGrant).toBe(false);
      expect(Option.isSome(before.data.paidSubscription)).toBe(true);
      expect(before.data.cancellation).toEqual(Option.none());
      const cancellation = yield* successfulCapability({
        db,
        operation: "subscription.cancelSubscription",
        input: {},
      });
      expect(cancellation).toMatchObject({ data: { sourceCancellation: "detached" } });
      const after = yield* standing();
      expect(after.data.accessTier).toBe("pro");
      expect(after.data.hasProGrant).toBe(false);
      expect(after.data.paidSubscription).toEqual(before.data.paidSubscription);
      expect(after.data.recentAttempts).toEqual(before.data.recentAttempts);
      expect(Option.isSome(after.data.cancellation)).toBe(true);
      const repeated = yield* exerciseTurn({
        db,
        text: "Quiero cancelar la suscripción de Fidy.",
        messageId: "wamid.already-cancelled-renewal",
        generate: () =>
          Promise.resolve(toolReply({ operation: "subscription.cancelSubscription", input: {} })),
      });
      expect(repeated.sent).toEqual(["La renovación de tu suscripción ya está cancelada."]);
      expect(repeated.confirmationCommands).toEqual([]);

      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS total FROM subscription_cancellations c JOIN subscriptions s ON s.id=c.subscription_id WHERE s.user_id=?"
            )
            .bind(users[0])
            .first()
        )
      ).toEqual({ total: 1 });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS total FROM hosted_confirmations WHERE user_id=? AND operation='subscription.cancelSubscription' AND consumed_at_ms IS NOT NULL"
            )
            .bind(users[0])
            .first()
        )
      ).toEqual({ total: 1 });
    })
  ));

it("advances Insight delivery, read and dismissal through WhatsApp without sending an external message", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const input = yield* Schema.decodeEffect(Schema.toCodecJson(InsightGenerationInput))({
        kind: "weekly-summary",
        scheduleId: "90000000-0000-4000-8000-000000000001",
        scheduleVersion: 1,
        serviceMarket: "CO",
        locale: "es-CO",
        timeZone: "America/Bogota",
        scheduledAt: DateTime.formatIso(DateTime.makeUnsafe(now() - 1000)),
        moneyGroups: [],
      });
      const generated = yield* generateInsight({ db, userId: UserId.make(users[0]), input });
      if (Option.isNone(generated)) return yield* Effect.die("Missing generated InsightEvent");
      const id = generated.value.id;
      yield* successfulCapability({
        db,
        operation: "insights.markInsightDelivered",
        input: {
          params: { id },
          payload: {
            sentAt: DateTime.formatIso(DateTime.makeUnsafe(now())),
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: "wamid.qa-synthetic-delivery",
          },
        },
      });
      yield* successfulCapability({
        db,
        operation: "insights.markInsightRead",
        input: { params: { id } },
      });
      yield* successfulCapability({
        db,
        operation: "insights.dismissInsight",
        input: { params: { id } },
      });
      expect(
        yield* successfulCapability({
          db,
          operation: "insights.listPendingInsights",
          input: { query: {} },
        })
      ).toMatchObject({ data: [] });
    })
  ));

it("reads and resolves an actual extracted NeedsReviewItem through WhatsApp", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const id = yield* seedReviewItem(db);
      const detail = yield* successfulCapability({
        db,
        operation: "ingestion.getReviewItem",
        input: { params: { id } },
      });
      const {
        data: { revision },
      } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.Struct({ revision: Schema.Int }) })
      )(detail);
      yield* successfulCapability({
        db,
        operation: "ingestion.applyReviewEdit",
        input: {
          payload: {
            _tag: "Create",
            id,
            revision,
            extraction: {
              money: { amount: "15500", currency: "COP" },
              direction: "outflow",
              counterparty: "Cafe QA",
              occurredAt: "2026-08-01T12:00:00Z",
            },
          },
        },
      });
      expect(
        yield* successfulCapability({
          db,
          operation: "ingestion.getReviewItem",
          input: { params: { id } },
        })
      ).toMatchObject({ data: { item: { status: "created" } } });
      const rows = yield* Effect.tryPromise(() =>
        db.prepare("SELECT amount,currency FROM transactions WHERE user_id=?").bind(users[0]).all()
      );
      expect(rows.results).toEqual([{ amount: "15500", currency: "COP" }]);
    })
  ));
