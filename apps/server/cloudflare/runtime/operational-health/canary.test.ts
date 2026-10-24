import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { completeCanary, receiveCanary, sendCanary } from "./operations";

it.effect("validates private canaries before Workflow handoff and completion", () =>
  Effect.gen(function* () {
    const now = 1_800_000;
    const created: string[] = [];
    const workflow = {
      create: (input: { id: string }): Promise<void> => {
        created.push(input.id);
        return Promise.resolve();
      },
      get: (): Promise<{ status: () => Promise<unknown> }> =>
        Promise.resolve({ status: () => Promise.resolve({ status: "complete" }) }),
    };
    for (const payload of [
      { version: 1, sentAtMs: "malformed" },
      { version: 1, sentAtMs: now + 1 },
      { version: 1, sentAtMs: now - 600_001 },
    ]) {
      yield* Effect.tryPromise(() =>
        expect(receiveCanary({ workflow, now, payload })).rejects.toThrow(
          "Invalid operational canary"
        )
      );
      yield* Effect.tryPromise(() =>
        expect(completeCanary({ now, payload })).rejects.toThrow("Invalid operational canary")
      );
    }
    expect(created).toEqual([]);
    yield* Effect.tryPromise(() =>
      receiveCanary({ workflow, now, payload: { version: 1, sentAtMs: now - 500 } })
    );
    expect(created).toEqual([`operational-canary-${Math.floor((now - 500) / 300_000)}`]);
    yield* Effect.tryPromise(() =>
      expect(
        completeCanary({ payload: { version: 1, sentAtMs: now }, now })
      ).resolves.toBeUndefined()
    );
  })
);

it.effect("publishes once across the five minute ticks of a canary period", () =>
  Effect.gen(function* () {
    const sent: unknown[] = [];
    const queue = {
      send: (body: unknown): Promise<QueueSendResponse> => {
        sent.push(body);
        return Promise.resolve({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
      },
    };
    for (const now of [3_005_000, 3_065_000, 3_125_000, 3_185_000, 3_245_000, 3_305_000]) {
      yield* Effect.tryPromise(() =>
        sendCanary({ queue, now, signal: new AbortController().signal })
      );
    }
    expect(sent).toEqual([
      { version: 1, sentAtMs: 3_000_000 },
      { version: 1, sentAtMs: 3_300_000 },
    ]);
  })
);
