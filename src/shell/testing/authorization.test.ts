import { expect, layer } from "@effect/vitest";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { AgentTokenId } from "~/core/_shared/agent-token";
import { UserId } from "~/core/_shared/user";
import { CategoryKeyword } from "~/core/categories/model";
import { categoryIds } from "~/core/categories/taxonomy";
import { InsightEventId } from "~/core/insights/model";
import { CreateTransactionInput } from "~/core/transactions/model";
import { AgentBearerToken } from "~/core/tokens/model";
import { authenticateAgentToken } from "~/shell/_shared/authz";
import { ScopeMissing } from "~/shell/_shared/errors";
import { truncateAuditLogEntries } from "~/shell/audit/fixtures";
import { observeAuditLogEntries } from "~/shell/audit/repo";
import { truncateInsights, weeklySummaryInput } from "~/shell/insights/fixtures";
import { generateInsightEvent } from "~/shell/insights/repo";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";
import {
  ApiHarness,
  type ApiClient,
  ApiHarnessClient,
  headersFor,
  makeApiClientLive,
} from "./api-harness";
import { seedAgentIdentity } from "~/shell/db/development-seed";

const encodeTransactionPayload = Schema.encodeSync(CreateTransactionInput);

const readOnlyUser = UserId.make("f1d1a000-0000-4000-8000-0000000000c3");
const readOnlyBearer = AgentBearerToken.make(
  "fin_readonly_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const readOnlyTokenId = AgentTokenId.make("f1d1a000-0000-4000-8000-0000000000c4");
const writeOnlyUser = UserId.make("f1d1a000-0000-4000-8000-0000000000c5");
const writeOnlyBearer = AgentBearerToken.make(
  "fin_writonly_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const readOnlyWriterBearer = AgentBearerToken.make(
  "fin_authwrit_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const expiredUser = UserId.make("f1d1a000-0000-4000-8000-0000000000e4");
const expiredBearer = AgentBearerToken.make(
  "fin_expired1_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const expiredObserverBearer = AgentBearerToken.make(
  "fin_expread1_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const revokedUser = UserId.make("f1d1a000-0000-4000-8000-0000000000f5");
const revokedBearer = AgentBearerToken.make(
  "fin_revoked1_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const revokedObserverBearer = AgentBearerToken.make(
  "fin_revread1_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const idleUser = UserId.make("f1d1a000-0000-4000-8000-0000000000d6");
const idleBearer = AgentBearerToken.make("fin_idle090d_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
class ReadOnlyApiClient extends Context.Service<ReadOnlyApiClient, ApiClient>()(
  "fidy-ai/shell/testing/authorization.test/ReadOnlyApiClient"
) {}
class WriteOnlyApiClient extends Context.Service<WriteOnlyApiClient, ApiClient>()(
  "fidy-ai/shell/testing/authorization.test/WriteOnlyApiClient"
) {}
class ReadOnlyWriterClient extends Context.Service<ReadOnlyWriterClient, ApiClient>()(
  "fidy-ai/shell/testing/authorization.test/ReadOnlyWriterClient"
) {}

const AuthorizationHarness = Layer.mergeAll(
  makeApiClientLive({ tag: ReadOnlyApiClient, bearer: readOnlyBearer }),
  makeApiClientLive({ tag: WriteOnlyApiClient, bearer: writeOnlyBearer }),
  makeApiClientLive({ tag: ReadOnlyWriterClient, bearer: readOnlyWriterBearer })
).pipe(Layer.provideMerge(ApiHarness));

const seedReadOnlyIdentity = seedAgentIdentity({
  userId: readOnlyUser,
  bearer: readOnlyBearer,
  tokenId: readOnlyTokenId,
  scopes: ["read"],
});
const seedWriteOnlyIdentity = seedAgentIdentity({
  userId: writeOnlyUser,
  bearer: writeOnlyBearer,
  scopes: ["write"],
});

layer(AuthorizationHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "AgentToken authorization",
  (it) => {
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
            params: { id: InsightEventId.make("f1d1a000-0000-4000-8000-000000000299") },
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
          encodeTransactionPayload(transactionPayload({ merchant: "Tostao" }))
        );
        const missing = yield* HttpClient.post("/transactions", { body });
        const unknown = yield* HttpClient.post("/transactions", {
          headers: {
            authorization: "Bearer fin_unknown1_0123456789abcdefghijklmnopqrstuvwxyzABCD",
          },
          body,
        });
        const history = yield* client.transactions.listTransactions({ query: {} });

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

        const listed = yield* client.transactions.listTransactions({ query: {} });
        yield* truncateAuditLogEntries;
        const denied = yield* HttpClient.post("/transactions", {
          headers: headersFor(readOnlyBearer),
          body: HttpBody.jsonUnsafe(
            encodeTransactionPayload(transactionPayload({ merchant: "Tostao" }))
          ),
        });
        const deniedBody = yield* denied.json;
        const auditEntries = yield* observeAuditLogEntries(readOnlyUser);
        const afterDenial = yield* client.transactions.listTransactions({ query: {} });

        expect(listed.data).toEqual([]);
        expect(denied.status).toBe(403);
        expect(deniedBody).toMatchObject({ error: { code: "scope_missing" } });
        expect(afterDenial.data).toEqual([]);
        expect(auditEntries).toHaveLength(1);
        expect(auditEntries[0]).toMatchObject({
          subjectUserId: readOnlyUser,
          tokenId: readOnlyTokenId,
          operation: "transactions.createTransaction",
          outcome: "rejected",
        });
        expect(DateTime.isUtc(auditEntries[0]?.occurredAt ?? DateTime.makeUnsafe(0))).toBe(true);
      })
    );

    it.effect("rejects every new under-scoped mutation without changing owned records", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        yield* truncateAuditLogEntries;
        yield* seedReadOnlyIdentity;
        yield* seedAgentIdentity({
          userId: readOnlyUser,
          bearer: readOnlyWriterBearer,
          scopes: ["read", "write"],
        });
        const reader = yield* ReadOnlyApiClient;
        const writer = yield* ReadOnlyWriterClient;
        const transaction = yield* writer.transactions.createTransaction({
          payload: transactionPayload({ merchant: "Owned unchanged" }),
        });
        const rule = yield* writer.categories.createKeywordRule({
          payload: {
            keyword: CategoryKeyword.make("owned-rule"),
            categoryId: categoryIds.otros,
          },
        });
        yield* truncateAuditLogEntries;

        const failures = yield* Effect.all([
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
          Effect.flip(reader.categories.deleteKeywordRule({ params: { id: rule.data.id } })),
          Effect.flip(
            reader.transactions.updateTransaction({
              params: { id: transaction.data.id },
              payload: {
                money: transaction.data.money,
                merchant: "Denied update",
                direction: transaction.data.direction,
                categoryId: transaction.data.categoryId,
                notes: transaction.data.notes,
                occurredAt: transaction.data.occurredAt,
              },
            })
          ),
          Effect.flip(
            reader.transactions.deleteTransaction({ params: { id: transaction.data.id } })
          ),
        ]);
        const rules = yield* writer.categories.listKeywordRules({});
        const retained = yield* writer.transactions.getTransaction({
          params: { id: transaction.data.id },
        });
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
        ]);
        expect(rules.data).toEqual([rule.data]);
        expect(retained.data).toEqual(transaction.data);
        expect(
          auditEntries
            .filter((entry) => entry.outcome === "rejected")
            .map((entry) => [entry.operation, entry.outcome])
        ).toEqual([
          ["categories.createKeywordRule", "rejected"],
          ["categories.updateKeywordRule", "rejected"],
          ["categories.deleteKeywordRule", "rejected"],
          ["transactions.updateTransaction", "rejected"],
          ["transactions.deleteTransaction", "rejected"],
        ]);
      })
    );

    it.effect("keeps an AgentToken active throughout its 90-day idle window", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const tokenCreatedAt = DateTime.subtractDuration(now, "60 days");
        yield* seedAgentIdentity({
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
        yield* seedAgentIdentity({
          userId: expiredUser,
          bearer: expiredBearer,
          tokenCreatedAt: expiredCreatedAt,
          idleExpiresAt: DateTime.addDuration(expiredCreatedAt, "90 days"),
        });
        yield* seedAgentIdentity({
          userId: revokedUser,
          bearer: revokedBearer,
          tokenCreatedAt: revokedCreatedAt,
          idleExpiresAt: DateTime.addDuration(revokedCreatedAt, "90 days"),
          revokedAt: Option.some(DateTime.makeUnsafe("2026-07-01T00:00:00Z")),
        });
        yield* seedAgentIdentity({
          userId: expiredUser,
          bearer: expiredObserverBearer,
          scopes: ["read"],
        });
        yield* seedAgentIdentity({
          userId: revokedUser,
          bearer: revokedObserverBearer,
          scopes: ["read"],
        });
        const body = HttpBody.jsonUnsafe(
          encodeTransactionPayload(transactionPayload({ merchant: "Tostao" }))
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
          HttpClient.get("/transactions", { headers: headersFor(expiredObserverBearer) }),
          HttpClient.get("/transactions", { headers: headersFor(revokedObserverBearer) }),
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
        const found = yield* authenticateAgentToken({ bearer: readOnlyBearer, usedAt });
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

    it.effect("does not regress usage when AgentToken resolutions complete out of order", () =>
      Effect.gen(function* () {
        yield* seedReadOnlyIdentity;
        const earlierUse = yield* DateTime.now;
        const laterUse = DateTime.addDuration(earlierUse, "1 day");

        yield* authenticateAgentToken({ bearer: readOnlyBearer, usedAt: laterUse });
        const staleResolution = yield* authenticateAgentToken({
          bearer: readOnlyBearer,
          usedAt: earlierUse,
        });

        expect(Option.getOrThrow(staleResolution).lastUsedAt).toEqual(laterUse);
      })
    );
  }
);
