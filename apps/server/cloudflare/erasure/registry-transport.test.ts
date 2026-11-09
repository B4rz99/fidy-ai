import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeRemoteErasureRegistry } from "./runtime";

const generationKey = "recovery/generation";
const foreignKey = "recovery/cases/12740000-0000-4000-8000-000000000001";
const maximumResponseBytes = 65536;

it("refuses private-file keys and oversized writes before sending a metadata request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let requests = 0;
      const registry = makeRemoteErasureRegistry({
        fetch: () => {
          requests++;
          return Promise.resolve(new Response(null, { status: 500 }));
        },
      });
      yield* Effect.tryPromise(() =>
        expect(registry.get("users/private-original")).rejects.toBeDefined()
      );
      yield* Effect.tryPromise(() =>
        expect(registry.put(foreignKey, "x".repeat(maximumResponseBytes))).rejects.toBeDefined()
      );
      expect(requests).toBe(0);
    })
  ));

it.each([
  { key: foreignKey, size: 7, value: "initial" },
  { key: generationKey, size: 1, value: "initial" },
])("refuses a metadata response for another key or an inconsistent body", (row) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = makeRemoteErasureRegistry({
        fetch: () => Promise.resolve(Response.json({ ...row, etag: "etag", uploaded: 1 })),
      });
      yield* Effect.tryPromise(() => expect(registry.get(generationKey)).rejects.toBeDefined());
    })
  )
);

it("cancels oversized metadata responses instead of buffering them", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let cancelled = false;
      const registry = makeRemoteErasureRegistry({
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller): void {
                  controller.enqueue(new Uint8Array(maximumResponseBytes));
                },
                cancel(): void {
                  cancelled = true;
                },
              }),
              { headers: { "content-type": "application/json" } }
            )
          ),
      });
      yield* Effect.tryPromise(() => expect(registry.get(generationKey)).rejects.toBeDefined());
      expect(cancelled).toBe(true);
    })
  ));
