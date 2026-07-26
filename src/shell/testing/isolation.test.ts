import { expect, layer } from "@effect/vitest";
import { Effect, type Schema } from "effect";
import { HttpBody, HttpClient, type HttpClientError } from "effect/unstable/http";
import { UserId } from "~/core/_shared/user";
import { type Transaction } from "~/core/transactions/model";
import type { NotFound, Unauthenticated, ValidationFailed } from "~/shell/_shared/errors";
import type { OperationId } from "~/shell/api";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";
import { ApiHarness, type ApiClient, clientFor, headersFor } from "./api-harness";
import { publishedOperationIds } from "./openapi";

const owner = UserId.make("f1d1a000-0000-4000-8000-0000000000a1");
const stranger = UserId.make("f1d1a000-0000-4000-8000-0000000000b2");

/**
 * What one operation, invoked by a stranger, is handed: a client for each user
 * and the transaction the owner already logged.
 */
interface IsolationAttempt {
  readonly ownerClient: ApiClient;
  readonly strangerClient: ApiClient;
  readonly ownedTransaction: Transaction;
}

/** Everything a call through the derived client, or a raw one, can fail with. */
type CallFailure =
  | Schema.SchemaError
  | HttpClientError.HttpClientError
  | NotFound
  | Unauthenticated
  | ValidationFailed;

type IsolationProbe = (
  attempt: IsolationAttempt
) => Effect.Effect<void, CallFailure, HttpClient.HttpClient>;

/**
 * One probe per canonical operation: invoke it as the stranger, then assert the
 * owner's transaction is neither visible in the answer nor changed by it.
 *
 * Keyed by `OperationId`, which is derived from the assembled `HttpApi`, so an
 * operation added without a probe fails to compile here, and the test below
 * catches the runtime case — a published operation this union never heard of.
 */
const probes: Record<OperationId, IsolationProbe> = {
  "transactions.listTransactions": (attempt) =>
    Effect.gen(function* () {
      const listed = yield* attempt.strangerClient.transactions.listTransactions();

      expect(listed.data).toEqual([]);
    }),

  "transactions.createTransaction": (attempt) =>
    Effect.gen(function* () {
      yield* attempt.strangerClient.transactions.createTransaction({
        payload: transactionPayload({ merchant: "Rappi" }),
      });

      // The owner is context, not a field, so the payload has no `userId` for
      // the typed client to send. Naming one over raw HTTP is accepted — and
      // ignored: the row belongs to whoever called, not to whoever was named.
      const forged = yield* HttpClient.post("/transactions", {
        headers: headersFor(stranger),
        body: HttpBody.jsonUnsafe({
          money: { amount: "8000", currency: "COP" },
          merchant: "Tostao",
          direction: "outflow",
          occurredAt: "2026-07-21T09:00:00Z",
          userId: owner,
        }),
      });

      expect(forged.status).toBe(201);

      const ownersHistory = yield* attempt.ownerClient.transactions.listTransactions();
      const strangersHistory = yield* attempt.strangerClient.transactions.listTransactions();

      expect(ownersHistory.data).toEqual([attempt.ownedTransaction]);
      expect(strangersHistory.data).toHaveLength(2);
    }),

  "transactions.getTransaction": (attempt) =>
    Effect.gen(function* () {
      const denied = yield* Effect.result(
        attempt.strangerClient.transactions.getTransaction({
          params: { id: attempt.ownedTransaction.id },
        })
      );

      // The same answer an id that never existed gets, so asking cannot be used
      // to discover which ids are real.
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });

      const owners = yield* attempt.ownerClient.transactions.getTransaction({
        params: { id: attempt.ownedTransaction.id },
      });

      expect(owners.data).toEqual(attempt.ownedTransaction);
    }),
};

const seedAttempt = Effect.gen(function* () {
  const ownerClient = yield* clientFor(owner);
  const strangerClient = yield* clientFor(stranger);
  const created = yield* ownerClient.transactions.createTransaction({
    payload: transactionPayload(),
  });

  return { ownerClient, strangerClient, ownedTransaction: created.data };
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "per-user isolation",
  (it) => {
    it.effect("every canonical operation the server publishes is probed here", () =>
      Effect.gen(function* () {
        const published = yield* publishedOperationIds;

        expect([...published].sort()).toEqual(Object.keys(probes).sort());
      })
    );

    for (const [operation, probe] of Object.entries(probes)) {
      it.effect(`${operation} exposes nothing of another user's to its caller`, () =>
        Effect.gen(function* () {
          yield* truncateTransactions;
          const attempt = yield* seedAttempt;

          yield* probe(attempt);
        })
      );
    }
  }
);
