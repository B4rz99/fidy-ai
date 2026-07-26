import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { ValidationFailed } from "~/shell/_shared/errors";
import {
  ApiHarness,
  ApiHarnessClient,
  defaultCaller,
  headersFor,
} from "~/shell/testing/api-harness";
import { publishedOperationIds } from "~/shell/testing/openapi";
import { TransactionsGroup } from "./contract";
import { truncateTransactions } from "./fixtures";

const OpenApiComponents = Schema.Struct({
  components: Schema.Struct({
    schemas: Schema.Record(Schema.String, Schema.Unknown),
  }),
});

/**
 * Every operation this slice declares, named as the generators name it. Read
 * off the group rather than listed here, so an operation added to the contract
 * is one the spec has to publish without anyone remembering to say so
 * (CODING_STANDARDS.md, tests).
 */
const declaredOperationIds = Object.keys(TransactionsGroup.endpoints).map(
  (endpoint) => `${TransactionsGroup.identifier}.${endpoint}`
);

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "transactions contract",
  (it) => {
    it.effect("the derived server rejects a payload that violates the contract", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        // The typed client cannot represent an invalid payload, so this
        // decode-gate check speaks raw HTTP at the same server.
        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultCaller),
          body: HttpBody.jsonUnsafe({ amount: -5, currency: "USD" }),
        });

        expect(response.status).toBe(400);

        const listed = yield* client.transactions.listTransactions();
        expect(listed.data).toEqual([]);
      })
    );

    it.effect("a malformed payload answers with the error envelope, not a bare 400", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultCaller),
          body: HttpBody.jsonUnsafe({ amount: -5, currency: "USD" }),
        });
        const body = yield* response.json;

        expect(body).toMatchObject({
          error: { code: "validation_failed" },
          next: [],
        });
      })
    );

    it.effect("a rejected payload names the field at fault, not the whole parse", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultCaller),
          body: HttpBody.jsonUnsafe({
            amount: -5,
            currency: "COP",
            merchant: "El Corral",
            direction: "outflow",
            occurredAt: "2026-07-20T12:30:00Z",
          }),
        });
        const failure = yield* Schema.decodeUnknownEffect(ValidationFailed)(yield* response.json);

        expect(failure.error.fields.map((field) => field.path)).toEqual(["amount"]);
        expect(failure.error.fields.map((field) => field.message).join("\n")).toContain(
          "greater than 0"
        );
      })
    );

    it.effect("a body that is not an object at all carries no path, rather than a blank one", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultCaller),
          body: HttpBody.jsonUnsafe("a transaction, honest"),
        });
        const failure = yield* Schema.decodeUnknownEffect(ValidationFailed)(yield* response.json);

        // The key is absent, not an empty string: a caller never reads a value
        // standing in for the lack of one. It does not follow that absence
        // means the whole value was wrong — the case below sends a body with
        // exactly one nameable field at fault and is answered the same way.
        expect(failure.error.fields.length).toBeGreaterThan(0);
        expect(failure.error.fields.every((field) => field.path === undefined)).toBe(true);
      })
    );

    it.effect("a body whose only fault is one field is still answered without naming it", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultCaller),
          body: HttpBody.jsonUnsafe({
            amount: 25000,
            currency: "USD",
            merchant: "El Corral",
            direction: "outflow",
            occurredAt: "2026-07-20T12:30:00Z",
          }),
        });
        const failure = yield* Schema.decodeUnknownEffect(ValidationFailed)(yield* response.json);

        // Pinned as it is, not endorsed. `currency` alone is wrong and there is
        // a name for it, yet the answer names nothing and quotes the whole body
        // back — the parser's own rendering, valid fields and all. The spec
        // (GitHub issue #1) and ARCHITECTURE.md §6 both say a validation
        // failure carries field-level `{ path, message }` and never a raw parse
        // dump, so this is a gap with a ticket of its own; closing it turns
        // these two expectations into `["currency"]` and a message about that
        // one value.
        expect(failure.error.fields.every((field) => field.path === undefined)).toBe(true);
        expect(failure.error.fields.map((field) => field.message).join("\n")).toContain(
          '"merchant":"El Corral"'
        );
      })
    );

    it.effect(
      "a path parameter that is not a transaction id is rejected as a validation failure",
      () =>
        Effect.gen(function* () {
          yield* truncateTransactions;

          const response = yield* HttpClient.get("/transactions/not-a-uuid", {
            headers: headersFor(defaultCaller),
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

          // No affordance: nothing this API publishes changes a credential
          // (ARCHITECTURE.md §6), so `next` stays empty rather than guessing.
          expect(body).toMatchObject({
            error: { code: "unauthenticated" },
            next: [],
          });
        })
    );

    it.effect("the derived server rejects an amount beyond the JSON-safe integer range", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultCaller),
          body: HttpBody.jsonUnsafe({
            amount: 2 ** 53,
            currency: "COP",
            merchant: "Constructora Bolívar",
            direction: "outflow",
            occurredAt: "2026-07-22T15:00:00Z",
          }),
        });

        expect(response.status).toBe(400);
      })
    );

    it.effect("the derived server rejects a garbage date string in occurredAt", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(defaultCaller),
          body: HttpBody.jsonUnsafe({
            amount: 25000,
            currency: "COP",
            merchant: "El Corral",
            direction: "outflow",
            occurredAt: "not-a-date",
          }),
        });

        expect(response.status).toBe(400);

        const listed = yield* client.transactions.listTransactions();
        expect(listed.data).toEqual([]);
      })
    );

    it.effect("the server publishes every operation this slice's contract declares", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const operationIds = yield* publishedOperationIds;

        // Asserted before the filter below, which a contract declaring nothing
        // would satisfy while the server published nothing either.
        expect(declaredOperationIds.length).toBeGreaterThan(0);

        const unpublished = declaredOperationIds.filter((id) => !operationIds.includes(id));

        expect(unpublished).toEqual([]);
      })
    );

    it.effect("the published OpenAPI spec names the shared contract schemas as components", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;

        const response = yield* HttpClient.get("/openapi.json");
        expect(response.status).toBe(200);
        const body = yield* response.json;
        const spec = yield* Schema.decodeUnknownEffect(OpenApiComponents)(body);

        expect(Object.keys(spec.components.schemas)).toContain("Transaction");
      })
    );
  }
);
