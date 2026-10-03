import { expect, it } from "@effect/vitest";
import {
  atomicBatchChildOperations,
  atomicBatchOperation,
  decideOperationAccess,
  operationCatalog,
} from "@fidy/server/client";
import { Effect, Fiber, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { formatFailure } from "../command/operations";
import { discoverOperations, runOperationCommand } from "./operations";
import { makeCanonicalFixture } from "./canonical.test-fixture";
import { makeCanonicalClient } from "./runtime";

const fixture = makeCanonicalFixture(makeCanonicalClient);
const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Json));
const decode = Schema.decodeSync(Schema.fromJsonString(Schema.Json));
const callId = "01900000-0000-4000-8000-000000000010";
const transaction = {
  id: "01900000-0000-4000-8000-000000000001",
  money: { amount: "9007199254740993.15", currency: "USD" },
  direction: "outflow",
  categoryId: "01900000-0000-4000-8000-000000000002",
  occurredAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-02T00:00:00.000Z",
  revision: 0,
};
const input = {
  payload: {
    money: transaction.money,
    direction: transaction.direction,
    categoryId: transaction.categoryId,
    occurredAt: transaction.occurredAt,
  },
};

it.effect("sends a canonically decoded mutation and encodes exact transformed results", () =>
  Effect.gen(function* () {
    const envelope = { data: transaction, next: [] };
    const test = fixture({ body: encode(envelope), status: 201 }, ["write"]);
    yield* runOperationCommand(["transactions", "createTransaction", "--input", "-"], {
      ...test.dependencies,
      readInput: () => Effect.succeed(encode(input)),
    });
    expect(decode(test.stdout.join(""))).toEqual(envelope);
    expect(test.requests).toEqual(["https://api.fidyapp.com/transactions"]);
  })
);

it.effect(
  "keeps ordered batch correlation and child-specific rollback failures in machine output",
  () =>
    Effect.gen(function* () {
      const batch = {
        payload: { calls: [{ callId, operation: "transactions.createTransaction", input }] },
      };
      const success = {
        data: {
          results: [
            {
              callId,
              operation: "transactions.createTransaction",
              output: { data: transaction, next: [] },
            },
          ],
        },
        next: [],
      };
      const rejection = {
        error: {
          code: "scope_missing",
          message: "A child lacks authority.",
          failedCallIndex: 0,
          operation: "transactions.createTransaction",
          fields: [],
        },
        next: [],
      };
      for (const [body, status, failed] of [
        [success, 200, false],
        [rejection, 400, true],
      ] as const) {
        const test = fixture({ body: encode(body), status }, ["write"]);
        expect(
          yield* runOperationCommand(["operations", "executeAtomicBatch", "--input", "-"], {
            ...test.dependencies,
            readInput: () => Effect.succeed(encode(batch)),
          })
        ).toBe(failed);
        expect(decode(test.stdout.join(""))).toEqual(body);
        expect(test.requests).toHaveLength(1);
        if (failed) expect(test.stderr.join("")).toContain("cambios de dominio no se confirmaron");
      }
    })
);

it.effect("transports a valid twelve-child batch beyond the bootstrap request budget", () =>
  Effect.gen(function* () {
    const calls = Array.from({ length: 12 }, (_, index) => ({
      callId: `01900000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      operation: "transactions.createTransaction",
      input: { payload: { ...input.payload, notes: "あ".repeat(500) } },
    }));
    const body = {
      data: {
        results: calls.map((child) => ({
          callId: child.callId,
          operation: child.operation,
          output: { data: transaction, next: [] },
        })),
      },
      next: [],
    };
    const test = fixture({ body: encode(body), status: 200 }, ["write"]);
    expect(
      yield* runOperationCommand(["operations", "executeAtomicBatch", "--input", "-"], {
        ...test.dependencies,
        readInput: () => Effect.succeed(encode({ payload: { calls } })),
      })
    ).toBe(false);
    expect(decode(test.stdout.join(""))).toEqual(body);
    expect(test.requests).toHaveLength(1);
  })
);

it.effect("does not promise rollback when a batch returns an unindexed unavailable failure", () =>
  Effect.gen(function* () {
    const test = fixture(
      {
        body: encode({ error: { code: "unavailable", message: "Unavailable." }, next: [] }),
        status: 503,
      },
      ["write"]
    );
    expect(
      yield* Effect.result(
        runOperationCommand(["operations", "executeAtomicBatch", "--input", "-"], {
          ...test.dependencies,
          readInput: () =>
            Effect.succeed(
              encode({
                payload: {
                  calls: [{ callId, operation: "transactions.createTransaction", input }],
                },
              })
            ),
        })
      )
    ).toMatchObject({ failure: { reason: "MutationAmbiguous" } });
    expect(test.stderr.join("")).not.toContain("no se confirmaron");
    expect(test.requests).toHaveLength(1);
  })
);

it.effect(
  "rejects malformed, empty, oversized, query, recursive and standalone batch children before transport",
  () =>
    Effect.gen(function* () {
      const child = { callId, operation: "transactions.createTransaction", input };
      for (const calls of [
        null,
        {},
        [],
        Array.from({ length: 13 }, () => child),
        [{ ...child, operation: "categories.listCategories", input: {} }],
        [
          {
            ...child,
            operation: "operations.executeAtomicBatch",
            input: { payload: { calls: [child] } },
          },
        ],
        [{ ...child, operation: "pats.revokeAllPATs", input: {} }],
        [
          {
            ...child,
            input: { payload: { ...input.payload, money: { amount: "1e3", currency: "COP" } } },
          },
        ],
      ]) {
        const test = fixture(undefined, ["write", "dashboard"]);
        expect(
          yield* Effect.result(
            runOperationCommand(["operations", "executeAtomicBatch", "--input", "-"], {
              ...test.dependencies,
              readInput: () => Effect.succeed(encode({ payload: { calls } })),
            })
          )
        ).toMatchObject({ failure: { reason: "InvalidInput" } });
        expect(test.requests).toEqual([]);
      }
    })
);

it.effect(
  "keeps every ineligible catalog entry unavailable through direct invocation as the catalog grows",
  () =>
    Effect.gen(function* () {
      const test = fixture(undefined, ["read", "write", "dashboard"]);
      const visible = discoverOperations(["read", "write", "dashboard"]);
      for (const operation of operationCatalog.operations) {
        const allowed =
          decideOperationAccess(operation.policy.access, {
            _tag: "PAT",
            capabilities: ["read", "write", "dashboard"],
          })._tag === "Allowed";
        expect(visible.some(({ id }) => id === operation.id)).toBe(allowed);
        if (allowed) continue;
        expect(
          yield* Effect.result(runOperationCommand(operation.id.split("."), test.dependencies))
        ).toMatchObject({ failure: { reason: "OperationUnavailable" } });
      }
      expect(test.requests).toEqual([]);
      expect(discoverOperations(["read"]).every(({ policy }) => policy.kind === "query")).toBe(
        true
      );
      for (const child of atomicBatchChildOperations(operationCatalog)) {
        expect(child.policy.kind).toBe("mutation");
        expect(child.id).not.toBe(atomicBatchOperation);
      }
    })
);

it.effect(
  "never replays transport loss or a deadline and cancels locally owned mutation work",
  () =>
    Effect.gen(function* () {
      const test = fixture(undefined, ["dashboard"]);
      let calls = 0;
      const lost = HttpClient.make((request) => {
        calls += 1;
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: "private transport cause",
            }),
          })
        );
      });
      expect(
        yield* Effect.result(
          runOperationCommand(["dashboard", "initializeDashboard"], {
            ...test.dependencies,
            httpClient: lost,
          })
        )
      ).toMatchObject({ failure: { reason: "MutationAmbiguous" } });
      expect(calls).toBe(1);
      for (const interrupt of [false, true]) {
        let cancelled = false;
        const pending = HttpClient.make((request) => {
          calls += 1;
          return Effect.succeed(
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
          );
        });
        const fiber = yield* Effect.result(
          runOperationCommand(["dashboard", "initializeDashboard"], {
            ...test.dependencies,
            httpClient: pending,
          })
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust(interrupt ? "1 second" : "16 seconds");
        if (interrupt) {
          yield* Fiber.interrupt(fiber);
          expect(test.stderr.join("")).toContain("servidor puede haber confirmado cambios");
        } else {
          expect(yield* Fiber.join(fiber)).toMatchObject({
            failure: { reason: "MutationAmbiguous" },
          });
        }
        expect(cancelled).toBe(true);
      }
      expect(calls).toBe(3);
      expect(test.stdout).toEqual([]);
      const recovery = formatFailure({ reason: "MutationAmbiguous", json: false });
      expect(recovery).toContain("No repitas");
      expect(recovery).toContain("Inspecciona el estado actual");
    })
);
