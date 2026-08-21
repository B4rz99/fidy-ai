import { expect, layer } from "@effect/vitest";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { PATId } from "~/core/tokens/reference";
import { UserId } from "~/core/identity/reference";
import { CategoryKeyword } from "~/core/categories/model";
import { categoryIds } from "~/core/categories/taxonomy";
import { InsightEventId } from "~/core/insights/model";
import { MemoryText } from "~/core/memory/model";
import { CreateTransactionInput } from "~/core/transactions/model";
import { TokenBearer } from "~/core/tokens/model";
import { authenticateTokenBearer } from "~/shell/_shared/authz-live";
import { ScopeMissing } from "~/shell/_shared/errors";
import { MigrationSqlClient } from "~/shell/db/client";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { truncateAuditLogEntries } from "~/shell/audit/fixtures";
import { observeAuditLogEntries } from "~/shell/audit/repo";
import { truncateInsights, weeklySummaryInput } from "~/shell/insights/fixtures";
import { generateInsightEvent } from "~/shell/insights/repo";
import { truncateMemories } from "~/shell/memory/fixtures";
import { AtomicBatchCallId } from "~/shell/operations/operations";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";
import {
  type ApiClient,
  ApiHarness,
  ApiHarnessClient,
  headersFor,
  makeApiClientLive,
} from "./api-harness";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";

const encodeTransactionPayload = Schema.encodeSync(CreateTransactionInput);

const truncateBudgets = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`TRUNCATE budget_month_latches, budgets`;
});

const readOnlyUser = UserId.make("f1d1a000-0000-4000-8000-0000000000c3");
const readOnlyBearer = TokenBearer.make("fin_readonly_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const readOnlyTokenId = PATId.make("f1d1a000-0000-4000-8000-0000000000c4");
const writeOnlyUser = UserId.make("f1d1a000-0000-4000-8000-0000000000c5");
const writeOnlyBearer = TokenBearer.make("fin_writonly_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const readOnlyWriterBearer = TokenBearer.make(
  "fin_authwrit_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const expiredUser = UserId.make("f1d1a000-0000-4000-8000-0000000000e4");
const expiredBearer = TokenBearer.make("fin_expired1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const expiredObserverBearer = TokenBearer.make(
  "fin_expread1_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const revokedUser = UserId.make("f1d1a000-0000-4000-8000-0000000000f5");
const revokedBearer = TokenBearer.make("fin_revoked1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const revokedObserverBearer = TokenBearer.make(
  "fin_revread1_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const idleUser = UserId.make("f1d1a000-0000-4000-8000-0000000000d6");
const idleBearer = TokenBearer.make("fin_idle090d_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
class ReadOnlyApiClient extends Context.Service<ReadOnlyApiClient, ApiClient>()(
  "@fidy/server/shell/testing/authorization.test/ReadOnlyApiClient"
) {}
class WriteOnlyApiClient extends Context.Service<WriteOnlyApiClient, ApiClient>()(
  "@fidy/server/shell/testing/authorization.test/WriteOnlyApiClient"
) {}
class ReadOnlyWriterClient extends Context.Service<ReadOnlyWriterClient, ApiClient>()(
  "@fidy/server/shell/testing/authorization.test/ReadOnlyWriterClient"
) {}

const AuthorizationHarness = Layer.mergeAll(
  makeApiClientLive({ tag: ReadOnlyApiClient, bearer: readOnlyBearer }),
  makeApiClientLive({ tag: WriteOnlyApiClient, bearer: writeOnlyBearer }),
  makeApiClientLive({
    tag: ReadOnlyWriterClient,
    bearer: readOnlyWriterBearer,
  })
).pipe(Layer.provideMerge(ApiHarness));

const seedReadOnlyIdentity = seedConsentedPatIdentity({
  userId: readOnlyUser,
  bearer: readOnlyBearer,
  tokenId: readOnlyTokenId,
  scopes: ["read"],
});
const seedWriteOnlyIdentity = seedConsentedPatIdentity({
  userId: writeOnlyUser,
  bearer: writeOnlyBearer,
  scopes: ["write"],
});

const tokenUseState = Schema.Struct({
  lastUsedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  idleExpiresAt: Schema.DateTimeUtcFromDate,
});

/** Renewal state a rejected canonical call must leave exactly as it found it. */
const readTokenUse = Effect.fn("readTokenUse")(function* (userId: UserId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withUserTransaction(
    userId,
    SqlSchema.findOne({
      Request: UserId,
      Result: tokenUseState,
      execute: (owner) => sql`
        SELECT last_used_at AS "lastUsedAt", idle_expires_at AS "idleExpiresAt"
        FROM tokens WHERE user_id = ${owner}
      `,
    })(userId)
  );
});

layer(AuthorizationHarness, {
  excludeTestServices: true,
  timeout: "30 seconds",
})("TokenBearer authorization", (it) => {
  it.effect("does not treat the retired caller header as User identity", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/transactions", {
        headers: {
          "x-fidy-caller": "f1d1a000-0000-4000-8000-0000000000a1",
        },
      });

      expect(response.status).toBe(401);
    })
  );

  it.effect("rejects unauthorized Subscription upgrade destination reads", () =>
    Effect.gen(function* () {
      yield* truncateAuditLogEntries;
      yield* seedWriteOnlyIdentity;

      const missing = yield* HttpClient.get("/subscription/upgrade-url");
      const underScoped = yield* HttpClient.get("/subscription/upgrade-url", {
        headers: headersFor(writeOnlyBearer),
      });
      const auditEntries = yield* observeAuditLogEntries(writeOnlyUser);

      expect([missing.status, underScoped.status]).toEqual([401, 403]);
      expect(auditEntries.map((entry) => [entry.operation, entry.outcome])).toContainEqual([
        "subscription.getUpgradeUrl",
        "rejected",
      ]);
    })
  );

  it.effect("enforces independent read and write scopes for Memory", () =>
    Effect.gen(function* () {
      yield* truncateMemories;
      yield* seedReadOnlyIdentity;
      yield* seedWriteOnlyIdentity;
      const reader = yield* ReadOnlyApiClient;
      const writer = yield* WriteOnlyApiClient;

      const deniedWrite = yield* Effect.result(
        reader.memory.remember({
          payload: { text: MemoryText.make("denied") },
        })
      );
      const remembered = yield* writer.memory.remember({
        payload: { text: MemoryText.make("write-only memory") },
      });
      const deniedRead = yield* Effect.result(writer.memory.recall());
      const recalled = yield* reader.memory.recall();

      expect(deniedWrite).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "scope_missing" } },
      });
      expect(deniedRead).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "scope_missing" } },
      });
      expect(recalled.data).toEqual([]);
      expect(remembered.data.text).toBe("write-only memory");
    })
  );

  it.effect("does not advertise or permit insight writes to a read-only caller", () =>
    Effect.gen(function* () {
      yield* truncateInsights;
      yield* seedReadOnlyIdentity;
      const client = yield* ReadOnlyApiClient;
      const events = yield* Effect.all([
        generateInsightEvent(readOnlyUser, weeklySummaryInput()),
        generateInsightEvent(readOnlyUser, weeklySummaryInput()),
        generateInsightEvent(readOnlyUser, weeklySummaryInput()),
      ]);
      const delivered = yield* Effect.result(
        client.insights.markInsightDelivered({
          params: { id: events[0].id },
          payload: {
            sentAt: DateTime.makeUnsafe("2026-08-09T23:00:08Z"),
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: "wamid.under-scoped",
          },
        })
      );
      const read = yield* Effect.result(
        client.insights.markInsightRead({ params: { id: events[1].id } })
      );
      const dismissed = yield* Effect.result(
        client.insights.dismissInsight({ params: { id: events[2].id } })
      );
      const pending = yield* client.insights.listPendingInsights();

      expect([delivered, read, dismissed].map(({ _tag }) => _tag)).toEqual([
        "Failure",
        "Failure",
        "Failure",
      ]);
      expect(pending.data).toHaveLength(3);
      expect(pending.next).toEqual([]);
    })
  );

  it.effect("does not suggest a read operation to a write-only caller", () =>
    Effect.gen(function* () {
      yield* seedWriteOnlyIdentity;
      const client = yield* WriteOnlyApiClient;
      const result = yield* Effect.result(
        client.insights.markInsightRead({
          params: {
            id: InsightEventId.make("f1d1a000-0000-4000-8000-000000000299"),
          },
        })
      );

      expect(result).toMatchObject({ _tag: "Failure", failure: { next: [] } });
    })
  );

  it.effect("returns 401 for missing, unknown, and provider-only bearer values", () =>
    Effect.gen(function* () {
      const missing = yield* HttpClient.get("/transactions");
      const unknown = yield* HttpClient.get("/transactions", {
        headers: {
          authorization: "Bearer fin_unknown1_0123456789abcdefghijklmnopqrstuvwxyzABCD",
        },
      });
      const providerOnly = yield* HttpClient.get("/transactions", {
        headers: { "x-kapso-contact-id": "provider-contact-42" },
      });

      expect([missing.status, unknown.status, providerOnly.status]).toEqual([401, 401, 401]);
    })
  );

  it.effect("rejects unknown mutating callers before storing a Transaction", () =>
    Effect.gen(function* () {
      yield* truncateTransactions;
      const client = yield* ApiHarnessClient;
      const body = HttpBody.jsonUnsafe(
        encodeTransactionPayload(transactionPayload({ counterparty: "Tostao" }))
      );
      const missing = yield* HttpClient.post("/transactions", { body });
      const unknown = yield* HttpClient.post("/transactions", {
        headers: {
          authorization: "Bearer fin_unknown1_0123456789abcdefghijklmnopqrstuvwxyzABCD",
        },
        body,
      });
      const history = yield* client.transactions.listTransactions({
        query: {},
      });

      expect([missing.status, unknown.status]).toEqual([401, 401]);
      expect(history.data).toEqual([]);
    })
  );

  it.effect("allows read but rejects an under-scoped write before storing it", () =>
    Effect.gen(function* () {
      yield* truncateTransactions;
      yield* truncateAuditLogEntries;
      yield* seedReadOnlyIdentity;
      const client = yield* ReadOnlyApiClient;

      const listed = yield* client.transactions.listTransactions({
        query: {},
      });
      yield* truncateAuditLogEntries;
      const denied = yield* HttpClient.post("/transactions", {
        headers: headersFor(readOnlyBearer),
        body: HttpBody.jsonUnsafe(
          encodeTransactionPayload(transactionPayload({ counterparty: "Tostao" }))
        ),
      });
      const deniedBody = yield* denied.json;
      const auditEntries = yield* observeAuditLogEntries(readOnlyUser);
      const afterDenial = yield* client.transactions.listTransactions({
        query: {},
      });

      expect(listed.data).toEqual([]);
      expect(denied.status).toBe(403);
      expect(deniedBody).toMatchObject({ error: { code: "scope_missing" } });
      expect(afterDenial.data).toEqual([]);
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0]).toMatchObject({
        subjectUserId: readOnlyUser,
        caller: { _tag: "PAT", patId: readOnlyTokenId },
        operation: "transactions.createTransaction",
        outcome: "rejected",
      });
    })
  );

  it.effect("leaves the PAT idle deadline untouched when an under-scoped write is rejected", () =>
    Effect.gen(function* () {
      yield* truncateTransactions;
      yield* truncateAuditLogEntries;
      yield* seedReadOnlyIdentity;
      const before = yield* readTokenUse(readOnlyUser);

      const denied = yield* HttpClient.post("/transactions", {
        headers: headersFor(readOnlyBearer),
        body: HttpBody.jsonUnsafe(
          encodeTransactionPayload(transactionPayload({ counterparty: "Tostao" }))
        ),
      });
      const after = yield* readTokenUse(readOnlyUser);

      expect(denied.status).toBe(403);
      expect(after).toEqual(before);
    })
  );

  it.effect("rejects every new under-scoped mutation without changing owned records", () =>
    Effect.gen(function* () {
      yield* truncateTransactions;
      yield* truncateBudgets;
      yield* truncateAuditLogEntries;
      yield* seedReadOnlyIdentity;
      yield* seedConsentedPatIdentity({
        userId: readOnlyUser,
        bearer: readOnlyWriterBearer,
        scopes: ["read", "write"],
      });
      const reader = yield* ReadOnlyApiClient;
      const writer = yield* ReadOnlyWriterClient;
      const transaction = yield* writer.transactions.createTransaction({
        payload: transactionPayload({ counterparty: "Owned unchanged" }),
      });
      const rule = yield* writer.categories.createKeywordRule({
        payload: {
          keyword: CategoryKeyword.make("owned-rule"),
          categoryId: categoryIds.otros,
        },
      });
      const budget = yield* writer.budgets.createBudget({
        payload: {
          categoryId: categoryIds.restaurantes,
          cap: transaction.data.money,
        },
      });
      yield* truncateAuditLogEntries;

      const memory = yield* writer.memory.remember({
        payload: { text: MemoryText.make("owned-memory") },
      });
      yield* truncateAuditLogEntries;

      const failures = yield* Effect.all([
        Effect.flip(
          reader.memory.revise({
            params: { id: memory.data.id },
            payload: { text: MemoryText.make("denied-memory-revision") },
          })
        ),
        Effect.flip(reader.memory.forget({ params: { id: memory.data.id } })),
        Effect.flip(
          reader.categories.createKeywordRule({
            payload: {
              keyword: CategoryKeyword.make("denied-rule"),
              categoryId: categoryIds.otros,
            },
          })
        ),
        Effect.flip(
          reader.categories.updateKeywordRule({
            params: { id: rule.data.id },
            payload: {
              keyword: CategoryKeyword.make("denied-update"),
              categoryId: categoryIds.otros,
            },
          })
        ),
        Effect.flip(
          reader.categories.deleteKeywordRule({
            params: { id: rule.data.id },
          })
        ),
        Effect.flip(
          reader.transactions.updateTransaction({
            params: { id: transaction.data.id },
            payload: {
              money: transaction.data.money,
              counterparty: Option.some("Denied update"),
              direction: transaction.data.direction,
              categoryId: transaction.data.categoryId,
              notes: transaction.data.notes,
              occurredAt: transaction.data.occurredAt,
            },
          })
        ),
        Effect.flip(
          reader.transactions.deleteTransaction({
            params: { id: transaction.data.id },
          })
        ),
        Effect.flip(
          reader.budgets.createBudget({
            payload: {
              categoryId: categoryIds.mercado,
              cap: transaction.data.money,
            },
          })
        ),
        Effect.flip(
          reader.budgets.updateBudget({
            params: { id: budget.data.id },
            payload: {
              categoryId: categoryIds.mercado,
              cap: budget.data.cap,
            },
          })
        ),
        Effect.flip(reader.budgets.deleteBudget({ params: { id: budget.data.id } })),
      ]);
      const memories = yield* writer.memory.recall();
      const rules = yield* writer.categories.listKeywordRules({});
      const retained = yield* writer.transactions.getTransaction({
        params: { id: transaction.data.id },
      });
      const retainedBudgets = yield* writer.budgets.listBudgets();
      const auditEntries = yield* observeAuditLogEntries(readOnlyUser);

      expect(
        failures.map((failure) =>
          Schema.is(ScopeMissing)(failure) ? failure.error.code : "unexpected"
        )
      ).toEqual([
        "scope_missing",
        "scope_missing",
        "scope_missing",
        "scope_missing",
        "scope_missing",
        "scope_missing",
        "scope_missing",
        "scope_missing",
        "scope_missing",
        "scope_missing",
      ]);
      expect(memories.data).toEqual([memory.data]);
      expect(rules.data).toEqual([rule.data]);
      expect(retained.data).toEqual(transaction.data);
      expect(retainedBudgets.data.map(({ id }) => id)).toEqual([budget.data.id]);
      expect(
        auditEntries
          .filter((entry) => entry.outcome === "rejected")
          .map((entry) => [entry.operation, entry.outcome])
      ).toEqual([
        ["memory.revise", "rejected"],
        ["memory.forget", "rejected"],
        ["categories.createKeywordRule", "rejected"],
        ["categories.updateKeywordRule", "rejected"],
        ["categories.deleteKeywordRule", "rejected"],
        ["transactions.updateTransaction", "rejected"],
        ["transactions.deleteTransaction", "rejected"],
        ["budgets.createBudget", "rejected"],
        ["budgets.updateBudget", "rejected"],
        ["budgets.deleteBudget", "rejected"],
      ]);
    })
  );

  it.effect("rejects an under-scoped batch child without committing it", () =>
    Effect.gen(function* () {
      yield* truncateTransactions;
      yield* truncateAuditLogEntries;
      yield* seedReadOnlyIdentity;
      const client = yield* ReadOnlyApiClient;

      const failure = yield* Effect.flip(
        client.operations.executeAtomicBatch({
          payload: {
            calls: [
              {
                callId: AtomicBatchCallId.make("f1d1a000-0000-4000-8000-000000000501"),
                operation: "transactions.createTransaction",
                input: {
                  payload: transactionPayload({
                    counterparty: "Denied batch mutation",
                  }),
                },
              },
            ],
          },
        })
      );
      const transactions = yield* client.transactions.listTransactions({
        query: {},
      });
      const auditEntries = yield* observeAuditLogEntries(readOnlyUser);

      expect(failure).toMatchObject({
        error: {
          code: "scope_missing",
          failedCallIndex: 0,
          operation: "transactions.createTransaction",
        },
      });
      expect(transactions.data).toEqual([]);
      expect(auditEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "transactions.createTransaction",
            outcome: "rejected",
          }),
        ])
      );
    })
  );

  it.effect("resolves and renews the TokenBearer exactly once for one request", () =>
    Effect.gen(function* () {
      yield* seedReadOnlyIdentity;
      const sql = yield* MigrationSqlClient;
      yield* sql`DROP TRIGGER IF EXISTS count_authentication_use ON tokens`;
      yield* sql`DROP FUNCTION IF EXISTS count_authentication_use()`;
      yield* sql`DROP TABLE IF EXISTS public.authentication_use_probe`;
      yield* sql`CREATE TABLE public.authentication_use_probe (calls integer NOT NULL)`;
      yield* sql`INSERT INTO public.authentication_use_probe (calls) VALUES (0)`;
      yield* sql`
          CREATE FUNCTION count_authentication_use() RETURNS trigger AS $$
          BEGIN
            IF NEW.id = ${sql.literal(`'${readOnlyTokenId}'::uuid`)} THEN
              UPDATE public.authentication_use_probe SET calls = calls + 1;
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql SECURITY DEFINER
        `;
      yield* sql`
          CREATE TRIGGER count_authentication_use AFTER UPDATE ON tokens
          FOR EACH ROW EXECUTE FUNCTION count_authentication_use()
        `;
      const removeProbe = sql`DROP TRIGGER IF EXISTS count_authentication_use ON tokens`.pipe(
        Effect.andThen(sql`DROP FUNCTION IF EXISTS count_authentication_use()`),
        Effect.andThen(sql`DROP TABLE IF EXISTS public.authentication_use_probe`),
        Effect.orDie
      );

      yield* Effect.gen(function* () {
        const response = yield* HttpClient.get("/transactions", {
          headers: headersFor(readOnlyBearer),
        });
        const probe = yield* SqlSchema.findOne({
          Request: Schema.Void,
          Result: Schema.Struct({ calls: Schema.Int }),
          execute: () => sql`SELECT calls FROM public.authentication_use_probe`,
        })(undefined).pipe(Effect.orDie);

        expect(response.status).toBe(200);
        expect(probe.calls).toBe(1);
      }).pipe(Effect.ensuring(removeProbe));
    })
  );

  it.effect("keeps a PAT active throughout its 90-day idle window", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const tokenCreatedAt = DateTime.subtractDuration(now, "60 days");
      yield* seedConsentedPatIdentity({
        userId: idleUser,
        bearer: idleBearer,
        tokenCreatedAt,
        idleExpiresAt: DateTime.addDuration(tokenCreatedAt, "90 days"),
      });

      const response = yield* HttpClient.get("/transactions", {
        headers: headersFor(idleBearer),
      });

      expect(response.status).toBe(200);
    })
  );

  it.effect("rejects idle-expired and revoked writes before storing a Transaction", () =>
    Effect.gen(function* () {
      yield* truncateTransactions;
      const expiredCreatedAt = DateTime.makeUnsafe("1999-01-01T00:00:00Z");
      const revokedCreatedAt = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
      yield* seedConsentedPatIdentity({
        userId: expiredUser,
        bearer: expiredBearer,
        tokenCreatedAt: expiredCreatedAt,
        idleExpiresAt: DateTime.addDuration(expiredCreatedAt, "90 days"),
      });
      yield* seedConsentedPatIdentity({
        userId: revokedUser,
        bearer: revokedBearer,
        tokenCreatedAt: revokedCreatedAt,
        idleExpiresAt: DateTime.addDuration(revokedCreatedAt, "90 days"),
        revokedAt: Option.some(DateTime.makeUnsafe("2026-07-01T00:00:00Z")),
      });
      yield* seedConsentedPatIdentity({
        userId: expiredUser,
        bearer: expiredObserverBearer,
        scopes: ["read"],
      });
      yield* seedConsentedPatIdentity({
        userId: revokedUser,
        bearer: revokedObserverBearer,
        scopes: ["read"],
      });
      const body = HttpBody.jsonUnsafe(
        encodeTransactionPayload(transactionPayload({ counterparty: "Tostao" }))
      );

      const expired = yield* HttpClient.post("/transactions", {
        headers: headersFor(expiredBearer),
        body,
      });
      const revoked = yield* HttpClient.post("/transactions", {
        headers: headersFor(revokedBearer),
        body,
      });
      const [expiredHistory, revokedHistory] = yield* Effect.all([
        HttpClient.get("/transactions", {
          headers: headersFor(expiredObserverBearer),
        }),
        HttpClient.get("/transactions", {
          headers: headersFor(revokedObserverBearer),
        }),
      ]);
      const [expiredHistoryBody, revokedHistoryBody] = yield* Effect.all([
        expiredHistory.json,
        revokedHistory.json,
      ]);

      expect([expired.status, revoked.status]).toEqual([401, 401]);
      expect([expiredHistory.status, revokedHistory.status]).toEqual([200, 200]);
      expect(expiredHistoryBody).toMatchObject({ data: [] });
      expect(revokedHistoryBody).toMatchObject({ data: [] });
    })
  );

  it.effect("stores a SHA-256 bearer hash and updates last-used time on resolution", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadOnlyIdentity;
      const usedAt = yield* DateTime.now;
      const found = yield* authenticateTokenBearer(usedAt)(readOnlyBearer);
      const resolved = Option.getOrThrow(found);

      expect(seeded.tokenHash).toBe(
        "a4a3272af8c2a5c5127af2aea12b848e93eb29ed2d1ab00d04752231b9224bae"
      );
      expect(seeded.tokenHash).not.toContain(readOnlyBearer);
      expect(resolved).toMatchObject({
        subjectUserId: readOnlyUser,
        scopes: ["read"],
        lastUsedAt: usedAt,
      });
    })
  );

  it.effect("does not regress usage when TokenBearer resolutions complete out of order", () =>
    Effect.gen(function* () {
      yield* seedReadOnlyIdentity;
      const earlierUse = yield* DateTime.now;
      const laterUse = DateTime.addDuration(earlierUse, "1 day");

      yield* authenticateTokenBearer(readOnlyBearer, laterUse);
      const staleResolution = yield* authenticateTokenBearer(readOnlyBearer, earlierUse);

      expect(Option.getOrThrow(staleResolution).lastUsedAt).toEqual(laterUse);
    })
  );
});
