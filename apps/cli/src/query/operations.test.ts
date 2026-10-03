import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Fiber, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { makeProtectedClient } from "../direct-client/runtime";
import { discoverQueries, runQueryCommand } from "./operations";
import { makeQueryFixture as constructQueryFixture } from "./query.test-fixture";
import { makeQueryClient } from "./runtime";

const makeQueryFixture = constructQueryFixture(makeQueryClient);

const encodeFixture = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeOutput = Schema.decodeSync(Schema.fromJsonString(Schema.Json));

it("offers read queries but never mutations or account-security work", () => {
  const commands = discoverQueries(["read"]);
  expect(commands.map((command) => command.id)).toContain("categories.listCategories");
  expect(commands.map((command) => command.id)).toContain("transactions.listTransactions");
  expect(commands.map((command) => command.id)).not.toContain("dashboard.initializeDashboard");
  expect(commands.map((command) => command.id)).not.toContain("pats.listPATs");
  expect(commands.map((command) => command.id)).not.toContain("operations.executeAtomicBatch");
  expect(discoverQueries([])).toEqual([]);
});

it.effect("executes an input-free query and emits only its canonical envelope on stdout", () =>
  Effect.gen(function* () {
    const fixture = makeQueryFixture();
    yield* runQueryCommand(["categories", "listCategories"], fixture.dependencies);
    expect(fixture.stdout).toEqual(['{"data":[],"next":[]}\n']);
    expect(fixture.requests).toEqual(["https://api.fidyapp.com/categories"]);
  })
);

it.effect("decodes nested query filters and encodes exact Money, dates and optional values", () =>
  Effect.gen(function* () {
    const transaction = {
      id: "01900000-0000-4000-8000-000000000001",
      money: { amount: "10000000000000001.01", currency: "COP" },
      direction: "outflow",
      categoryId: "01900000-0000-4000-8000-000000000002",
      notes: "texto\u001b[2J\u009b31m\u202esecreto",
      occurredAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-02T00:00:00.000Z",
      revision: 0,
    };
    const fixture = makeQueryFixture({
      body: encodeFixture({
        data: [transaction],
        next: [{ tool: "categories.listCategories", hint: "Browse categories." }],
      }),
      status: 200,
    });
    yield* runQueryCommand(["transactions", "listTransactions", "--input", "-"], {
      ...fixture.dependencies,
      readInput: () =>
        Effect.succeed('{"query":{"from":"2026-01-01T00:00:00.000Z","currency":"COP"}}'),
    });
    expect(decodeOutput(fixture.stdout.join(""))).toEqual({
      data: [transaction],
      next: [{ tool: "categories.listCategories", hint: "Browse categories." }],
    });
    expect(fixture.stdout.join("")).not.toContain("\u001b");
    expect(fixture.stdout.join("")).not.toContain("\u009b");
    expect(fixture.stdout.join("")).not.toContain("\u202e");
    expect(fixture.stderr.join("")).toContain("fidy categories listCategories");
    expect(fixture.requests).toHaveLength(1);
  })
);

it.effect(
  "rejects malformed, mismatched and conflicting inputs and ineligible commands before HTTP",
  () =>
    Effect.gen(function* () {
      const fixture = makeQueryFixture();
      for (const args of [
        ["transactions", "createTransaction"],
        ["pats", "listPATs"],
        ["unknown", "query"],
        ["transactions", "listTransactions"],
        ["categories", "listCategories", "--input", "request.json"],
        ["transactions", "listTransactions", "--input", "-", "--input", "file.json"],
      ]) {
        expect(
          Exit.isFailure(yield* Effect.exit(runQueryCommand(args, fixture.dependencies)))
        ).toBe(true);
      }
      for (const input of [
        '{"query":{"from":"bad"}}',
        '{"payload":{}}',
        '{"query":{},"responseMode":"response-only"}',
        "not json",
      ]) {
        const result = yield* Effect.result(
          runQueryCommand(["transactions", "listTransactions", "--input", "-"], {
            ...fixture.dependencies,
            readInput: () => Effect.succeed(input),
          })
        );
        expect(result).toMatchObject({ failure: { reason: "InvalidInput" } });
      }
      expect(fixture.requests).toEqual([]);
      expect(fixture.stdout).toEqual([]);
    })
);

it.effect(
  "retains declared failure envelopes and Retry-After without retrying or exposing the credential",
  () =>
    Effect.gen(function* () {
      const envelope = {
        error: {
          code: "unauthenticated",
          message: "Authenticate with a valid bearer token or web session.",
        },
        next: [],
      };
      const fixture = makeQueryFixture({ body: encodeFixture(envelope), status: 401 });
      expect(yield* runQueryCommand(["categories", "listCategories"], fixture.dependencies)).toBe(
        true
      );
      expect(decodeOutput(fixture.stdout.join(""))).toEqual(envelope);
      expect(fixture.stderr.join("")).toContain("12 segundos");
      expect(fixture.stderr.join("")).toContain("revocado");
      expect(fixture.stdout.join("") + fixture.stderr.join("")).not.toContain("fin_");
      expect(fixture.requests).toHaveLength(1);
    })
);

it.effect(
  "preserves HTTP-date Retry-After on declared failures without exposing other headers",
  () =>
    Effect.gen(function* () {
      const start = DateTime.makeUnsafe("2026-01-01T00:00:00Z").epochMilliseconds;
      yield* TestClock.setTime(start);
      const fixture = makeQueryFixture();
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              '{"error":{"code":"unauthenticated","message":"Authenticate."},"next":[]}',
              {
                status: 401,
                headers: {
                  "content-type": "application/json",
                  "retry-after": "Thu, 01 Jan 2026 00:00:12 GMT",
                  "x-private": "secret",
                },
              }
            )
          )
        )
      );
      expect(
        yield* runQueryCommand(["categories", "listCategories"], {
          ...fixture.dependencies,
          httpClient,
        })
      ).toBe(true);
      expect(fixture.stderr.join("")).toContain("12 segundos");
      expect(fixture.stderr.join("") + fixture.stdout.join("")).not.toContain("secret");
    })
);

it.effect(
  "contains malformed, oversized, redirected and unexpected responses in closed failures",
  () =>
    Effect.gen(function* () {
      const responseOverflow = 1_048_577;
      for (const response of [
        { body: "not json", status: 200 },
        { body: '{"data":"wrong","next":[]}', status: 200 },
        { body: "x".repeat(responseOverflow), status: 200 },
        { body: "{}", status: 302 },
        { body: "{}", status: 418 },
      ]) {
        const fixture = makeQueryFixture(response);
        expect(
          yield* Effect.result(
            runQueryCommand(["categories", "listCategories"], fixture.dependencies)
          )
        ).toMatchObject({ failure: { reason: "TransportUnavailable" } });
        expect(fixture.stdout).toEqual([]);
        expect(fixture.stderr).toEqual([]);
        expect(fixture.requests).toHaveLength(1);
      }
    })
);

it.effect(
  "rejects origin substitution before sending and cancels a pending authenticated response",
  () =>
    Effect.gen(function* () {
      const fixture = makeQueryFixture();
      const protectedClient = makeProtectedClient({
        client: fixture.dependencies.httpClient,
        allowQuery: true,
        maximumResponseBytes: 1024,
        captureRetry: () => {},
      });
      for (const destination of [
        "https://attacker.example/transactions",
        "https://api.fidyapp.com@attacker.example/transactions",
        "http://api.fidyapp.com/transactions",
      ]) {
        expect(Exit.isFailure(yield* Effect.exit(protectedClient.get(destination)))).toBe(true);
      }
      expect(fixture.requests).toEqual([]);
      let cancelled = false;
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                cancel: (): void => {
                  cancelled = true;
                },
              })
            )
          )
        )
      );
      const fiber = yield* runQueryCommand(["categories", "listCategories"], {
        ...fixture.dependencies,
        httpClient,
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.interrupt(fiber);
      expect(cancelled).toBe(true);
      expect(fixture.stdout).toEqual([]);
    })
);

it.effect("refuses absent and expired local access before HTTP", () =>
  Effect.gen(function* () {
    const fixture = makeQueryFixture();
    expect(
      yield* Effect.result(
        runQueryCommand(["categories", "listCategories"], {
          ...fixture.dependencies,
          store: { ...fixture.dependencies.store, load: Effect.succeedNone },
        })
      )
    ).toMatchObject({ failure: { reason: "LoginRequired" } });
    const saved = yield* fixture.dependencies.store.load;
    if (Option.isNone(saved)) throw new Error("fixture must contain access");
    yield* TestClock.setTime(saved.value.grant.pat.expiresAt.epochMilliseconds);
    expect(
      yield* Effect.result(runQueryCommand(["categories", "listCategories"], fixture.dependencies))
    ).toMatchObject({ failure: { reason: "Expired" } });
    expect(fixture.requests).toEqual([]);
  })
);

it.effect("keeps Consent revocation actionable and suggestions inert and query-only", () =>
  Effect.gen(function* () {
    const envelope = {
      error: {
        code: "user_action_required",
        message: "The User must take action in the web application.",
      },
      next: [],
    };
    const fixture = makeQueryFixture({ body: encodeFixture(envelope), status: 403 });
    expect(yield* runQueryCommand(["categories", "listCategories"], fixture.dependencies)).toBe(
      true
    );
    expect(decodeOutput(fixture.stdout.join(""))).toEqual(envelope);
    expect(fixture.stderr.join("")).toContain("Consentimiento");
    expect(fixture.requests).toHaveLength(1);
    const suggested = makeQueryFixture({
      body: encodeFixture({
        data: [],
        next: [{ tool: "transactions.createTransaction", hint: "Record a movement." }],
      }),
      status: 200,
    });
    yield* runQueryCommand(["categories", "listCategories"], suggested.dependencies);
    expect(suggested.requests).toHaveLength(1);
    expect(suggested.stderr.join("")).not.toContain("createTransaction");
    const unknown = makeQueryFixture({
      body: encodeFixture({ data: [], next: [{ tool: "unknown.execute", hint: "Execute." }] }),
      status: 200,
    });
    expect(
      yield* Effect.result(runQueryCommand(["categories", "listCategories"], unknown.dependencies))
    ).toMatchObject({ failure: { reason: "TransportUnavailable" } });
    expect(unknown.requests).toHaveLength(1);
    expect(unknown.stdout).toEqual([]);
  })
);

it.effect(
  "publishes machine discovery and help with the selected canonical nested input schema",
  () =>
    Effect.gen(function* () {
      const fixture = makeQueryFixture();
      yield* runQueryCommand(["commands"], fixture.dependencies);
      expect(fixture.stdout.join("")).toContain('"id":"transactions.listTransactions"');
      expect(fixture.stdout.join("")).not.toContain('"id":"transactions.createTransaction"');
      fixture.stdout.length = 0;
      yield* runQueryCommand(["transactions", "listTransactions", "--help"], fixture.dependencies);
      expect(fixture.stdout.join("")).toContain('"requiresInput":true');
      expect(fixture.stdout.join("")).toContain('"properties":{"query":');
      expect(fixture.stdout.join("")).toContain('"from":');
      expect(fixture.requests).toEqual([]);
    })
);
