import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { ValidationFailed } from "~/shell/_shared/errors";
import { ApiHarness, ApiHarnessClient, headersFor } from "~/shell/testing/api-harness";
import { defaultAgentBearer } from "~/shell/testing/identity-fixtures";
import { publishedOperationIds } from "~/shell/testing/openapi";
import { TransactionsGroup } from "./operations";
import { truncateTransactions } from "./fixtures";

const OpenApiComponents = Schema.Struct({
  components: Schema.Struct({
    schemas: Schema.Struct({
      Currency: Schema.Struct({ description: Schema.NonEmptyString }),
      Money: Schema.Struct({ description: Schema.NonEmptyString }),
      Transaction: Schema.Unknown,
    }),
  }),
});

/**
 * Every operation this slice declares, named as the generators name it. Read
 * off the group rather than listed here, so an operation added to the operation definitions
 * is one the spec has to publish without anyone remembering to say so
 * (CODING_STANDARDS.md, tests).
 */
const declaredOperationIds = Object.keys(TransactionsGroup.endpoints).map(
  (endpoint) => `${TransactionsGroup.identifier}.${endpoint}`
);

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "transaction operations",
  (it) => {
    it.effect("the derived server rejects a payload that violates the input schema", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        // The typed client cannot represent an invalid payload, so this
        // decode-gate check speaks raw HTTP at the same server.
        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe({ money: { amount: "-5", currency: "ZZZ" } }),
        });

        expect(response.status).toBe(400);

        const listed = yield* client.transactions.listTransactions({ query: {} });
        expect(listed.data).toEqual([]);
      })
    );

    it.effect("returns nested Money as normalized plain decimal text", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe({
            money: { amount: "25000.50", currency: "COP" },
            counterparty: "El Corral",
            direction: "outflow",
            occurredAt: "2026-07-20T12:30:00Z",
          }),
        });
        const body = yield* response.json;

        expect(response.status).toBe(201);
        expect(body).toMatchObject({ data: { money: { amount: "25000.5", currency: "COP" } } });
      })
    );

    it.effect(
      "a malformed payload answers with the structured error response, not a bare 400",
      () =>
        Effect.gen(function* () {
          yield* truncateTransactions;
          const privateValue = "fin_private_+573001234567_provider-message-42";

          const response = yield* HttpClient.post("/transactions", {
            headers: headersFor(defaultAgentBearer),
            body: HttpBody.jsonUnsafe({
              money: { amount: privateValue, currency: "ZZZ" },
            }),
          });
          const body = yield* response.json;
          const encodedBody = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(body);

          expect(body).toMatchObject({
            error: { code: "validation_failed" },
            next: [],
          });
          expect(encodedBody).not.toContain(privateValue);
        })
    );

    it.effect("a rejected payload names the field at fault, not the whole parse", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe({
            money: { amount: "-5", currency: "COP" },
            counterparty: "El Corral",
            direction: "outflow",
            occurredAt: "2026-07-20T12:30:00Z",
          }),
        });
        const failure = yield* Schema.decodeUnknownEffect(ValidationFailed)(yield* response.json);

        expect(failure.error.fields.map((field) => field.path)).toEqual(["money.amount"]);
        expect(failure.error.fields.map((field) => field.message).join("\n")).toContain(
          "non-negative plain decimal text"
        );
      })
    );

    it.effect(
      "rejects zero, over-precision, exponent, and locale-formatted Transaction Money",
      () =>
        Effect.gen(function* () {
          yield* truncateTransactions;

          for (const amount of ["0", "1.001", "1e3", "1,000"]) {
            const response = yield* HttpClient.post("/transactions", {
              headers: headersFor(defaultAgentBearer),
              body: HttpBody.jsonUnsafe({
                money: { amount, currency: "COP" },
                counterparty: "El Corral",
                direction: "outflow",
                occurredAt: "2026-07-20T12:30:00Z",
              }),
            });
            const failure = yield* Schema.decodeUnknownEffect(ValidationFailed)(
              yield* response.json
            );

            expect(response.status).toBe(400);
            expect(failure.error.fields.map((field) => field.path)).toContain("money.amount");
          }
        })
    );

    it.effect("a body that is not an object at all carries no path, rather than a blank one", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe("a transaction, honest"),
        });
        const failure = yield* Schema.decodeUnknownEffect(ValidationFailed)(yield* response.json);

        // The key is absent, not an empty string: a caller never reads a value
        // standing in for the lack of one. It does not follow that absence
        // means the whole value was wrong — the case below sends a body with
        // exactly one nameable field at fault and is answered the same way.
        expect(failure.error.fields.length).toBeGreaterThan(0);
        expect(failure.error.fields.every((field) => field.path === undefined)).toBe(true);
        expect(failure.error.fields.map((field) => field.message).join("\n")).not.toContain(
          "a transaction, honest"
        );
      })
    );

    it.effect("a wrong, null, or missing currency is attributed only to currency", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const validPayload = {
          money: { amount: "25000", currency: "COP" },
          counterparty: "El Corral",
          direction: "outflow",
          occurredAt: "2026-07-20T12:30:00Z",
        };
        const rejectedPayloads: ReadonlyArray<{
          readonly payload: Record<string, unknown>;
          readonly correction: string;
        }> = [
          {
            payload: { ...validPayload, money: { amount: "25000", currency: "ZZZ" } },
            correction: "Currency",
          },
          {
            payload: { ...validPayload, money: { amount: "25000", currency: null } },
            correction: "Currency",
          },
          {
            payload: { ...validPayload, money: { amount: "25000" } },
            correction: "Missing key",
          },
        ];

        for (const { payload, correction } of rejectedPayloads) {
          const response = yield* HttpClient.post("/transactions", {
            headers: headersFor(defaultAgentBearer),
            body: HttpBody.jsonUnsafe(payload),
          });
          const failure = yield* Schema.decodeUnknownEffect(ValidationFailed)(yield* response.json);
          const messages = failure.error.fields.map((field) => field.message).join("\n");

          expect(failure.error.fields.map((field) => field.path)).toEqual(["money.currency"]);
          expect(messages).toContain(correction);
          expect(messages).not.toContain('"counterparty":"El Corral"');
        }
      })
    );

    it.effect("a rejected payload reports every offending value in one response", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe({
            money: { amount: "-5", currency: "ZZZ" },
            counterparty: "",
            direction: "sideways",
            occurredAt: "2026-07-20T12:30:00Z",
          }),
        });
        const failure = yield* Schema.decodeUnknownEffect(ValidationFailed)(yield* response.json);

        expect(failure.error.fields.map((field) => field.path)).toEqual([
          "money.amount",
          "money.currency",
          "counterparty",
          "direction",
        ]);
      })
    );

    it.effect("a rejected payload reports every missing required value in one response", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe({ money: { currency: "COP" } }),
        });
        const failure = yield* Schema.decodeUnknownEffect(ValidationFailed)(yield* response.json);

        expect(failure.error.fields.map((field) => field.path)).toEqual([
          "money.amount",
          "direction",
          "occurredAt",
        ]);
      })
    );

    it.effect(
      "a path parameter that is not a transaction id is rejected as a validation failure",
      () =>
        Effect.gen(function* () {
          yield* truncateTransactions;

          const response = yield* HttpClient.get("/transactions/not-a-uuid", {
            headers: headersFor(defaultAgentBearer),
          });
          const failure = yield* Schema.decodeUnknownEffect(ValidationFailed)(yield* response.json);

          expect(response.status).toBe(400);
          expect(failure.error.message).toContain("path parameters");
          expect(failure.error.fields.map((field) => field.path)).toEqual(["id"]);
        })
    );

    it.effect("the derived server answers a request that names no caller with a 401", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.get("/transactions");

        expect(response.status).toBe(401);
      })
    );

    it.effect(
      "a request that names no caller is told so, and offered no way out over the API",
      () =>
        Effect.gen(function* () {
          yield* truncateTransactions;

          const response = yield* HttpClient.get("/transactions");
          const body = yield* response.json;

          // No SuggestedOperation: nothing this API publishes changes an AgentToken
          // (ARCHITECTURE.md §6), so `next` stays empty rather than guessing.
          expect(body).toMatchObject({
            error: { code: "unauthenticated" },
            next: [],
          });
        })
    );

    it.effect("rejects the legacy top-level amount and currency shape", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe({
            amount: 25000,
            currency: "COP",
            counterparty: "Constructora Bolívar",
            direction: "outflow",
            occurredAt: "2026-07-22T15:00:00Z",
          }),
        });
        const failure = yield* Schema.decodeUnknownEffect(ValidationFailed)(yield* response.json);

        expect(response.status).toBe(400);
        expect(failure.error.fields.map((field) => field.path)).toContain("money");
      })
    );

    it.effect("the derived server rejects a garbage date string in occurredAt", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultAgentBearer),
          body: HttpBody.jsonUnsafe({
            money: { amount: "25000", currency: "COP" },
            counterparty: "El Corral",
            direction: "outflow",
            occurredAt: "not-a-date",
          }),
        });

        expect(response.status).toBe(400);

        const listed = yield* client.transactions.listTransactions({ query: {} });
        expect(listed.data).toEqual([]);
      })
    );

    it.effect(
      "the server publishes every operation this slice's operation definitions declare",
      () =>
        Effect.gen(function* () {
          yield* truncateTransactions;

          const operationIds = yield* publishedOperationIds;

          // Asserted before the filter below, which an operation group declaring nothing
          // would satisfy while the server published nothing either.
          expect(declaredOperationIds.length).toBeGreaterThan(0);

          const unpublished = declaredOperationIds.filter((id) => !operationIds.includes(id));

          expect(unpublished).toEqual([]);
        })
    );

    it.effect("the published OpenAPI spec names the shared operation schemas as components", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.get("/openapi.json");
        expect(response.status).toBe(200);
        const body = yield* response.json;
        const spec = yield* Schema.decodeUnknownEffect(OpenApiComponents)(body);

        expect(spec.components.schemas.Currency.description).toContain("ISO 4217");
        expect(spec.components.schemas.Money.description).toContain("exact decimal");
      })
    );
  }
);
