import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Fiber, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { makeProtectedClient } from "../direct-client/runtime";
import {
  discoverOperations as discoverQueries,
  runOperationCommand as runQueryCommand,
} from "./operations";
import { makeCanonicalFixture as constructQueryFixture } from "./canonical.test-fixture";
import { makeCanonicalClient } from "./runtime";

const makeQueryFixture = constructQueryFixture(makeCanonicalClient);

const encodeFixture = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Json));
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

it("derives mutations and batches from independent write and dashboard grants", () => {
  const write = discoverQueries(["write"]).map((command) => command.id);
  const dashboard = discoverQueries(["dashboard"]).map((command) => command.id);
  expect(write).toContain("transactions.createTransaction");
  expect(write).toContain("operations.executeAtomicBatch");
  expect(write).not.toContain("dashboard.initializeDashboard");
  expect(dashboard).toContain("dashboard.initializeDashboard");
  expect(dashboard).toContain("operations.executeAtomicBatch");
  expect(dashboard).not.toContain("transactions.createTransaction");
});

it("describes only the caller's eligible batch children without publishing an independent contract", () => {
  for (const scopes of [["write"], ["dashboard"], ["write", "dashboard"]] as const) {
    const batch = discoverQueries(scopes).find(
      (operation) => operation.id === "operations.executeAtomicBatch"
    );
    expect(batch).toBeDefined();
    const input = encodeFixture(batch?.input);
    expect(input.includes("transactions.createTransaction")).toBe(
      scopes.some((scope) => scope === "write")
    );
    expect(input.includes("dashboard.initializeDashboard")).toBe(
      scopes.some((scope) => scope === "dashboard")
    );
    expect(input).not.toContain("pats.inspectPATPairing");
    expect(input).not.toContain("operations.executeAtomicBatch");
    expect(input).not.toContain("transactions.listTransactions");
  }
});

it.effect("rejects a batch child outside the saved grant even when the envelope is eligible", () =>
  Effect.gen(function* () {
    for (const child of [
      { operation: "dashboard.initializeDashboard", input: {} },
      { operation: "pats.inspectPATPairing", input: { payload: { publicCode: "ABCD-1234" } } },
    ]) {
      const fixture = makeQueryFixture(undefined, ["write"]);
      expect(
        yield* Effect.result(
          runQueryCommand(["operations", "executeAtomicBatch", "--input", "-"], {
            ...fixture.dependencies,
            readInput: () =>
              Effect.succeed(
                encodeFixture({
                  payload: {
                    calls: [{ callId: "01900000-0000-4000-8000-000000000001", ...child }],
                  },
                })
              ),
          })
        )
      ).toMatchObject({ failure: { reason: "OperationUnavailable" } });
      expect(fixture.requests).toEqual([]);
    }
  })
);

it.effect("contains uncertain mutation outcomes without replay or a no-effect claim", () =>
  Effect.gen(function* () {
    for (const response of [
      { body: "not json", status: 200 },
      { body: "{}", status: 503 },
      { body: "{}", status: 302 },
    ]) {
      const fixture = makeQueryFixture(response, ["dashboard"]);
      expect(
        yield* Effect.result(
          runQueryCommand(["dashboard", "initializeDashboard"], fixture.dependencies)
        )
      ).toMatchObject({ failure: { reason: "MutationAmbiguous" } });
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.stdout).toEqual([]);
    }
  })
);

it.effect("executes an input-free query and emits only its canonical envelope on stdout", () =>
  Effect.gen(function* () {
    const fixture = makeQueryFixture();
    yield* runQueryCommand(["categories", "listCategories"], fixture.dependencies);
    expect(fixture.stdout).toEqual(['{"data":[],"next":[]}\n']);
    expect(fixture.requests).toEqual(["https://api.fidyapp.com/categories"]);
  })
);

it.effect(
  "displays authoritative Free allowance on stderr without altering the canonical envelope or making extra calls",
  () =>
    Effect.gen(function* () {
      const fixture = makeQueryFixture({
        body: '{"data":[],"next":[]}',
        status: 200,
        headers: {
          "Fidy-Canonical-Allowance": "canonical_call",
          "Fidy-Canonical-Limit": "50",
          "Fidy-Canonical-Remaining": "49",
          "Fidy-Canonical-Reset": "2026-11-01T05:00:00.000Z",
        },
      });
      yield* runQueryCommand(["categories", "listCategories"], fixture.dependencies);
      expect(fixture.stdout).toEqual(['{"data":[],"next":[]}\n']);
      expect(fixture.stderr.join("")).toContain("49 de 50 llamadas canónicas restantes");
      expect(fixture.stderr.join("")).toContain("2026-11-01T05:00:00.000Z (UTC)");
      expect(fixture.requests).toEqual(["https://api.fidyapp.com/categories"]);
    })
);

it.effect(
  "keeps commercial exhaustion, security rejection and Pro-only failures distinct while preserving their metadata",
  () =>
    Effect.gen(function* () {
      for (const example of [
        {
          code: "quota_exhausted",
          status: 429,
          message: "Free allowance exhausted.",
          detail: { allowance: "canonical_call", resetsAt: "2026-11-01T05:00:00.000Z" },
          guidance: "sigue siendo Free",
          retry: "",
        },
        {
          code: "rate_limited",
          status: 429,
          message: "Request protection.",
          detail: {},
          guidance: "protección de solicitudes",
          retry: "12",
        },
        {
          code: "paywall_required",
          status: 402,
          message: "Pro capability.",
          detail: {},
          guidance: "requiere Pro",
          retry: "",
        },
        {
          code: "unauthenticated",
          status: 401,
          message: "Authenticate.",
          detail: {},
          guidance: "revocado",
          retry: "",
        },
      ]) {
        const envelope = {
          error: { code: example.code, message: example.message, ...example.detail },
          next: [],
        };
        const fixture = makeQueryFixture(
          {
            body: encodeFixture(envelope),
            status: example.status,
            headers: {
              "Fidy-Canonical-Allowance": "canonical_call",
              "Fidy-Canonical-Limit": "50",
              "Fidy-Canonical-Remaining": "0",
              "Fidy-Canonical-Reset": "2026-11-01T05:00:00.000Z",
              "retry-after": example.retry,
            },
          },
          ["read", "write"]
        );
        const args =
          example.code === "paywall_required"
            ? ["ingestion", "submitForExtraction", "--input", "-"]
            : ["categories", "listCategories"];
        expect(
          yield* runQueryCommand(args, {
            ...fixture.dependencies,
            readInput: () =>
              Effect.succeed(
                encodeFixture({
                  payload: {
                    idempotencyKey: "01900000-0000-4000-8000-000000000001",
                    reference: {
                      stagingId: "01900000-0000-4000-8000-000000000002",
                      byteLength: 1,
                      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    },
                  },
                })
              ),
          })
        ).toBe(true);
        expect(decodeOutput(fixture.stdout.join(""))).toEqual(envelope);
        expect(fixture.stderr.join("")).toContain("0 de 50 llamadas canónicas restantes");
        expect(fixture.stderr.join("")).toContain("2026-11-01T05:00:00.000Z (UTC)");
        expect(fixture.stderr.join("")).toContain(example.guidance);
        expect(fixture.stderr.join("").includes("12 segundos")).toBe(
          example.code === "rate_limited"
        );
        expect(fixture.requests).toHaveLength(1);
      }
    })
);

it.effect(
  "reports absent or malformed commercial metadata as unavailable without false zero counters or terminal injection",
  () =>
    Effect.gen(function* () {
      const valid = {
        "Fidy-Canonical-Allowance": "canonical_call",
        "Fidy-Canonical-Limit": "50",
        "Fidy-Canonical-Remaining": "49",
        "Fidy-Canonical-Reset": "2026-11-01T05:00:00.000Z",
      };
      const oversizedHeaderCharacters = 65;
      const unavailableHeaders: ReadonlyArray<Readonly<Record<string, string>>> = [
        {},
        { "RateLimit-Remaining": "0", "RateLimit-Reset": "12" },
        { ...valid, "Fidy-Canonical-Allowance": "other" },
        { ...valid, "Fidy-Canonical-Remaining": "" },
        { ...valid, "Fidy-Canonical-Remaining": "-1" },
        { ...valid, "Fidy-Canonical-Remaining": "51" },
        { ...valid, "Fidy-Canonical-Remaining": "9007199254740992" },
        { ...valid, "Fidy-Canonical-Reset": "not a date" },
        { ...valid, "Fidy-Canonical-Reset": "secret\u001b[2J\u009b" },
        { ...valid, "Fidy-Canonical-Remaining": "secret\u001b[2J" },
        { ...valid, "Fidy-Canonical-Remaining": "1".repeat(oversizedHeaderCharacters) },
        { ...valid, "Fidy-Canonical-Limit": "uncapped" },
      ];
      for (const headers of unavailableHeaders) {
        const fixture = makeQueryFixture({ body: '{"data":[],"next":[]}', status: 200, headers });
        yield* runQueryCommand(["categories", "listCategories"], fixture.dependencies);
        expect(fixture.stdout).toEqual(['{"data":[],"next":[]}\n']);
        const guidance = fixture.stderr.join("");
        expect(guidance).toContain("no disponible");
        expect(guidance).not.toContain("llamadas canónicas restantes");
        expect(guidance).not.toContain("secret");
        expect(guidance).not.toContain("\u001b");
        expect(guidance).not.toContain("\u202e");
        expect(fixture.requests).toHaveLength(1);
      }
    })
);

it.effect(
  "shows server uncapped standing without inventing a Trial/Pro meter and retains security guidance",
  () =>
    Effect.gen(function* () {
      for (const response of [
        { status: 200, body: '{"data":[],"next":[]}' },
        {
          status: 429,
          body: '{"error":{"code":"rate_limited","message":"Security protection."},"next":[]}',
        },
      ]) {
        const fixture = makeQueryFixture({
          ...response,
          headers: {
            "Fidy-Canonical-Allowance": "canonical_call",
            "Fidy-Canonical-Limit": "uncapped",
            "Fidy-Canonical-Remaining": "uncapped",
            "Fidy-Canonical-Reset": "2026-11-01T05:00:00.000Z",
            "retry-after": "12",
          },
        });
        yield* runQueryCommand(["categories", "listCategories"], fixture.dependencies);
        expect(decodeOutput(fixture.stdout.join(""))).toEqual(decodeOutput(response.body));
        expect(fixture.stderr.join("")).toContain("sin medidor comercial mensual");
        expect(fixture.stderr.join("")).toContain("protecciones de solicitudes y seguridad");
        expect(fixture.stderr.join("")).toContain("12 segundos");
        expect(fixture.stderr.join("")).not.toContain("llamadas canónicas restantes");
        expect(fixture.stderr.join("")).not.toContain("Reinicio:");
        expect(fixture.requests).toHaveLength(1);
      }
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
        maximumRequestBytes: 1024,
        captureRetry: () => {},
        captureAllowance: () => {},
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
