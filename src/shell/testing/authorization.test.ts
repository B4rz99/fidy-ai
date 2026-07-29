import { expect, layer } from "@effect/vitest";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { AgentTokenId } from "~/core/_shared/agent-token";
import { UserId } from "~/core/_shared/user";
import { CreateTransactionInput } from "~/core/transactions/model";
import { AgentBearerToken } from "~/core/tokens/model";
import { authenticateAgentToken } from "~/shell/_shared/authz";
import { truncateAuditLogEntries } from "~/shell/audit/fixtures";
import { observeAuditLogEntries } from "~/shell/audit/repo";
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

const AuthorizationHarness = makeApiClientLive({
  tag: ReadOnlyApiClient,
  bearer: readOnlyBearer,
}).pipe(Layer.provideMerge(ApiHarness));

const seedReadOnlyIdentity = seedAgentIdentity({
  userId: readOnlyUser,
  bearer: readOnlyBearer,
  tokenId: readOnlyTokenId,
  scopes: ["read"],
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
        const history = yield* client.transactions.listTransactions();

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

        const listed = yield* client.transactions.listTransactions();
        yield* truncateAuditLogEntries;
        const denied = yield* HttpClient.post("/transactions", {
          headers: headersFor(readOnlyBearer),
          body: HttpBody.jsonUnsafe(
            encodeTransactionPayload(transactionPayload({ merchant: "Tostao" }))
          ),
        });
        const deniedBody = yield* denied.json;
        const auditEntries = yield* observeAuditLogEntries(readOnlyUser);
        const afterDenial = yield* client.transactions.listTransactions();

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
