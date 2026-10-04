import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import { discoverOperations, runOperationCommand } from "./operations";
import { makeCanonicalFixture } from "./canonical.test-fixture";
import { makeCanonicalClient } from "./runtime";

const fixture = makeCanonicalFixture(makeCanonicalClient);

it.effect("invokes a query with a friendly schema-derived Currency flag", () =>
  Effect.gen(function* () {
    const test = fixture();
    yield* runOperationCommand(
      ["transactions", "listTransactions", "--currency", "COP"],
      test.dependencies
    );
    expect(test.requests).toEqual(["https://api.fidyapp.com/transactions"]);
    expect(test.stdout).toEqual(['{"data":[],"next":[]}\n']);
    expect(
      discoverOperations(["read"]).find((command) => command.id === "transactions.listTransactions")
    ).toMatchObject({
      flags: [
        { name: "from" },
        { name: "to" },
        { name: "category-id" },
        { name: "direction" },
        { name: "currency" },
        { name: "cursor" },
      ],
    });
  })
);

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const transaction = {
  id: "01900000-0000-4000-8000-000000000001",
  money: { amount: "9007199254740993.15", currency: "USD" },
  direction: "outflow",
  categoryId: "01900000-0000-4000-8000-000000000002",
  occurredAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-02T00:00:00.000Z",
  revision: 0,
} as const;
const mutationFlags = [
  "--amount",
  "9007199254740993.15",
  "--currency",
  "USD",
  "--direction",
  "outflow",
  "--category-id",
  transaction.categoryId,
  "--occurred-at",
  transaction.occurredAt,
];
const facts = {
  money: transaction.money,
  direction: transaction.direction,
  categoryId: transaction.categoryId,
  occurredAt: transaction.occurredAt,
};

it.effect(
  "flag and JSON invocations send the same exact Money request and return the same canonical result",
  () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const outputs: string[] = [];
      for (const args of [mutationFlags, ["--input", "-"]]) {
        const test = fixture(undefined, ["write"]);
        yield* runOperationCommand(["transactions", "createTransaction", ...args], {
          ...test.dependencies,
          readInput: () => Effect.succeed(encode({ payload: facts })),
          httpClient: HttpClient.make((request) =>
            Effect.sync(() => {
              if (request.body._tag === "Uint8Array") {
                bodies.push(new TextDecoder().decode(request.body.body));
              }
              return HttpClientResponse.fromWeb(
                request,
                new Response(encode({ data: transaction, next: [] }), {
                  status: 201,
                  headers: { "content-type": "application/json" },
                })
              );
            })
          ),
        });
        outputs.push(test.stdout.join(""));
      }
      expect(bodies).toEqual([encode(facts), encode(facts)]);
      expect(outputs).toEqual([
        encode({ data: transaction, next: [] }) + "\n",
        encode({ data: transaction, next: [] }) + "\n",
      ]);
    })
);

it.effect("query flags and JSON keep the same canonical filter representation", () =>
  Effect.gen(function* () {
    const queries: string[] = [];
    for (const args of [
      ["--currency", "COP", "--direction", "outflow"],
      ["--input", "-"],
    ]) {
      const test = fixture();
      yield* runOperationCommand(["transactions", "listTransactions", ...args], {
        ...test.dependencies,
        readInput: () => Effect.succeed('{"query":{"currency":"COP","direction":"outflow"}}'),
        httpClient: HttpClient.make((request) =>
          Effect.sync(() => {
            queries.push(UrlParams.toString(request.urlParams));
            return HttpClientResponse.fromWeb(
              request,
              new Response('{"data":[],"next":[]}', {
                headers: { "content-type": "application/json" },
              })
            );
          })
        ),
      });
      expect(test.stdout).toEqual(['{"data":[],"next":[]}\n']);
    }
    expect(queries).toEqual(["direction=outflow&currency=COP", "direction=outflow&currency=COP"]);
  })
);

it.effect(
  "rejects mixed, duplicate, unknown, nested, free-text and malformed flags before any request or file read",
  () =>
    Effect.gen(function* () {
      const invalid = [
        [...mutationFlags, "--input", "-"],
        [...mutationFlags, "--input", "request.json"],
        [...mutationFlags, "--amount", "1"],
        [...mutationFlags, "--payload.money.amount", "1"],
        [...mutationFlags, "--notes", "secret-prose"],
        [...mutationFlags, "--unknown", "secret-prose"],
        ["--currency=COP"],
        ["--currency"],
        mutationFlags.map((value) => (value === "9007199254740993.15" ? "1.001" : value)),
        mutationFlags.map((value) => (value === "9007199254740993.15" ? "1e3" : value)),
        mutationFlags.map((value) => (value === "9007199254740993.15" ? "0" : value)),
        mutationFlags.map((value) => (value === transaction.categoryId ? "bad-id" : value)),
        mutationFlags.map((value) => (value === transaction.occurredAt ? "bad-date" : value)),
        mutationFlags.map((value) => (value === "outflow" ? "invalid" : value)),
        ["--amount", "1", "--currency", "COP", "--direction", "outflow"],
      ];
      for (const args of invalid) {
        const test = fixture(undefined, ["write"]);
        let reads = 0;
        const result = yield* Effect.result(
          runOperationCommand(["transactions", "createTransaction", ...args], {
            ...test.dependencies,
            readInput: () =>
              Effect.sync(() => {
                reads += 1;
                return "{}";
              }),
          })
        );
        expect(result).toMatchObject({ failure: { reason: "InvalidInput" } });
        expect(test.requests).toEqual([]);
        expect(test.stdout).toEqual([]);
        expect(test.stderr).toEqual([]);
        expect(reads).toBe(0);
      }
    })
);

it.effect("does not make private account-security work available through friendly flags", () =>
  Effect.gen(function* () {
    const test = fixture(undefined, ["read", "write", "dashboard"]);
    expect(
      yield* Effect.result(
        runOperationCommand(
          ["pats", "approvePATPairing", "--device-code", "secret"],
          test.dependencies
        )
      )
    ).toMatchObject({ failure: { reason: "OperationUnavailable" } });
    expect(test.requests).toEqual([]);
    const batch = discoverOperations(["write"]).find(
      (command) => command.id === "operations.executeAtomicBatch"
    );
    expect(batch).toMatchObject({
      flags: [],
      structured: [{ path: ["payload", "calls"], required: true }],
    });
    expect(batch?.flagHelp).toContain("--input");
  })
);
