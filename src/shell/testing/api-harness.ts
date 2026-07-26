import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Context, DateTime, Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { SqlClient } from "effect/unstable/sql";
import { UserId } from "~/core/_shared/user";
import { Amount, type CreateTransactionInput } from "~/core/transactions/model";
import { callerHeader } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { PgLive } from "~/shell/db/client";
import { AppLive } from "~/shell/http";

/**
 * Derives the typed client from the ambient HttpClient, which the test server
 * layer points at whatever port the harness bound. Every request it makes
 * names `caller`, because every canonical operation runs as somebody.
 */
export const clientFor = (caller: UserId) =>
  HttpApiClient.make(FidyApi, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader(callerHeader, caller)),
  });

/** The same credential for tests that speak raw HTTP instead of the typed client. */
export const headersFor = (caller: UserId): Record<string, string> => ({ [callerHeader]: caller });

/** The user an API-seam test acts as when it has no reason to name another. */
export const defaultCaller = UserId.make("f1d1a000-0000-4000-8000-000000000001");

/** The derived client's shape, for tests holding one per user rather than the service. */
export type ApiClient = Effect.Success<ReturnType<typeof clientFor>>;

/** The derived typed client as a service, so tests can just yield it. */
export class ApiHarnessClient extends Context.Service<ApiHarnessClient, ApiClient>()(
  "fidy-ai/shell/testing/api-harness/ApiHarnessClient"
) {}

/**
 * The API seam: the real handler stack served over a real socket against a
 * real Postgres (DATABASE_URL), exercised through the derived typed client.
 * Tests run under Bun (vitest on the Bun runtime), matching the production
 * entrypoint, so the socket is a Bun HTTP server. The layer also exposes the
 * test HttpClient, already pointed at the server, for raw HTTP checks.
 */
export const ApiHarness = Layer.effect(ApiHarnessClient, clientFor(defaultCaller)).pipe(
  Layer.provideMerge(AppLive),
  Layer.provideMerge(BunHttpServer.layerTest),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(PgLive)
);

/** Resets harness state between tests. */
export const truncateTransactions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`TRUNCATE transactions`;
});

/**
 * What a caller sends to record a Transaction, defaulted so a test spells out
 * only what it is about: an outflow of 25_000 COP to "El Corral" on
 * 2026-07-20T12:30:00Z.
 *
 * Those values are a plausible movement, not a promise — a test whose assertion
 * turns on one of them should pass it as an override rather than read it off
 * the default.
 */
export const transactionPayload = (
  overrides?: Partial<CreateTransactionInput>
): CreateTransactionInput => ({
  amount: Amount.make(25_000),
  currency: "COP",
  merchant: "El Corral",
  direction: "outflow",
  occurredAt: DateTime.makeUnsafe("2026-07-20T12:30:00Z"),
  ...overrides,
});
