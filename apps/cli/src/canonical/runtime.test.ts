import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Option } from "effect";
import { TestClock } from "effect/testing";
import { makeCanonicalFixture } from "./canonical.test-fixture";
import {
  makeCanonicalClient,
  makeInputReader,
  readOperationInput as readQueryInput,
} from "./runtime";

layer(BunFileSystem.layer)((it) => {
  it.effect(
    "rejects invalid path, query and payload fields before sending an authenticated request",
    () =>
      Effect.gen(function* () {
        const fixture = makeCanonicalFixture(makeCanonicalClient)(undefined, ["read", "write"]);
        const credential = Option.getOrThrow(yield* fixture.dependencies.store.load);
        const client = yield* makeCanonicalClient({
          httpClient: fixture.dependencies.httpClient,
          credential,
          captureRetry: () => {},
          captureAllowance: () => {},
        });
        for (const { name, input } of [
          { name: "getTransaction", input: { params: { id: "invalid-id" } } },
          { name: "listTransactions", input: { query: { currency: "invalid-currency" } } },
          { name: "createTransaction", input: { payload: {} } },
        ]) {
          const call = Option.getOrThrow(Option.fromUndefinedOr(client.transactions?.[name]));
          expect(
            yield* Effect.result(
              call({
                params: undefined,
                query: undefined,
                payload: undefined,
                headers: undefined,
                ...input,
              })
            )
          ).toMatchObject({ failure: { _tag: "SchemaError" } });
        }
        expect(fixture.requests).toEqual([]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "reads a bounded UTF-8 JSON file and rejects oversize, invalid bytes and missing files safely",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const path = `${directory}/request.json`;
        yield* fs.writeFileString(path, '{"query":{"counterparty":"Café"}}');
        expect(yield* readQueryInput(path)).toBe('{"query":{"counterparty":"Café"}}');
        const overflowBytes = 65_537;
        yield* fs.writeFile(path, new Uint8Array(overflowBytes));
        expect(yield* Effect.result(readQueryInput(path))).toMatchObject({
          failure: { reason: "InputTooLarge" },
        });
        const invalidUtf8 = 255;
        yield* fs.writeFile(path, new Uint8Array([invalidUtf8]));
        expect(yield* Effect.result(readQueryInput(path))).toMatchObject({
          failure: { reason: "InvalidInput" },
        });
        expect(yield* Effect.result(readQueryInput(`${directory}/absent.json`))).toMatchObject({
          failure: { reason: "InvalidInput" },
        });
      }).pipe(Effect.scoped)
  );

  it.effect(
    "cancels explicit stdin on overflow, deadline and interruption without emitting partial input",
    () =>
      Effect.gen(function* () {
        let cancelled = false;
        const overflowBytes = 65_537;
        const overflow = makeInputReader((path) => {
          expect(path).toBe("-");
          return new ReadableStream<Uint8Array>({
            start: (controller): void => {
              controller.enqueue(new Uint8Array(overflowBytes));
            },
            cancel: (): void => {
              cancelled = true;
            },
          });
        });
        expect(yield* Effect.result(overflow("-"))).toMatchObject({
          failure: { reason: "InputTooLarge" },
        });
        expect(cancelled).toBe(true);
        cancelled = false;
        const pending = makeInputReader(
          () =>
            new ReadableStream<Uint8Array>({
              cancel: (): void => {
                cancelled = true;
              },
            })
        );
        const deadline = yield* pending("-").pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("16 seconds");
        expect(yield* Fiber.join(deadline)).toMatchObject({ failure: { reason: "InvalidInput" } });
        expect(cancelled).toBe(true);
        cancelled = false;
        const interrupted = yield* pending("-").pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* Fiber.interrupt(interrupted);
        expect(cancelled).toBe(true);
      })
  );
});
