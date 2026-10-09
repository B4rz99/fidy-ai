import { Clock, Effect, Schema } from "effect";
import { type Mock, expect, it, vi } from "vitest";
import { UserId } from "../../src/core/identity/contract";
import { TranscriptTurnId } from "../../src/core/agent/contract";
import { WhatsAppWork } from "./contract";
import { receiveWhatsAppWork } from "./runtime";

const queuedMessage = (
  index: number,
  turn = index
): Readonly<{
  body: WhatsAppWork;
  ack: Mock<() => void>;
  retry: Mock<() => void>;
}> => ({
  body: {
    _tag: "HostedWhatsAppWork",
    userId: UserId.make(`10000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
    turnId: TranscriptTurnId.make(`20000000-0000-4000-8000-${String(turn).padStart(12, "0")}`),
  },
  ack: vi.fn(),
  retry: vi.fn(),
});

it("dispatches ten Users with bounded concurrency, per-User order and independent retry decisions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const distinct = Array.from({ length: 10 }, (_, index) => queuedMessage(index));
      const duplicate = queuedMessage(0, 10);
      const malformed = { body: { text: "untrusted" }, ack: vi.fn(), retry: vi.fn() };
      const first = distinct[0];
      if (first === undefined) return yield* Effect.die("missing fixture");
      const starts: Array<Readonly<{ userId: UserId; turnId: TranscriptTurnId; age: number }>> = [];
      const activeUsers = new Set<UserId>();
      let maximum = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const admittedAt = yield* Clock.currentTimeMillis;
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      const running = receiveWhatsAppWork({
        messages: [first, duplicate, malformed, ...distinct.slice(1)],
        coordinator: {
          getByName: (name): Pick<Fetcher, "fetch"> => ({
            fetch: (request) =>
              run(
                Effect.gen(function* () {
                  const work = yield* Schema.decodeUnknownEffect(WhatsAppWork)(
                    yield* Effect.tryPromise(() => new Request(request).json())
                  );
                  expect(work.userId).toBe(name);
                  expect(activeUsers.has(work.userId)).toBe(false);
                  activeUsers.add(work.userId);
                  maximum = Math.max(maximum, activeUsers.size);
                  starts.push({
                    userId: work.userId,
                    turnId: work.turnId,
                    age: (yield* Clock.currentTimeMillis) - admittedAt,
                  });
                  yield* Effect.sleep("20 seconds");
                  activeUsers.delete(work.userId);
                  if (work.userId === distinct[2]?.body.userId) {
                    return yield* Effect.fail("synthetic coordinator transport failure");
                  }
                  return new Response(null, {
                    status: work.userId === distinct[1]?.body.userId ? 503 : 202,
                  });
                })
              ),
          }),
        },
      });
      try {
        yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
        expect(starts).toHaveLength(4);
        expect(starts.every(({ age }) => age === 0)).toBe(true);
        yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(60_001));
        yield* Effect.tryPromise(() => running);
        expect(maximum).toBe(4);
        expect(activeUsers.size).toBe(0);
        expect(starts).toHaveLength(11);
        expect(Math.max(...starts.map(({ age }) => age))).toBe(40_000);
        expect(starts.filter(({ userId }) => userId === first.body.userId)).toEqual([
          { userId: first.body.userId, turnId: first.body.turnId, age: 0 },
          { userId: duplicate.body.userId, turnId: duplicate.body.turnId, age: 20_000 },
        ]);
        for (const [index, message] of distinct.entries()) {
          expect(message.retry).toHaveBeenCalledTimes(index === 1 || index === 2 ? 1 : 0);
          expect(message.ack).toHaveBeenCalledTimes(index === 1 || index === 2 ? 0 : 1);
        }
        expect(duplicate.ack).toHaveBeenCalledOnce();
        expect(duplicate.retry).not.toHaveBeenCalled();
        expect(malformed.ack).toHaveBeenCalledOnce();
        expect(malformed.retry).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    })
  ));

it("lets unrelated Users finish while a stalled User and its successor remain ordered", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const stalled = queuedMessage(0);
      const successor = queuedMessage(0, 20);
      const unrelated = Array.from({ length: 4 }, (_, index) => queuedMessage(index + 1));
      const gate = Promise.withResolvers<void>();
      const starts: Array<TranscriptTurnId> = [];
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      const running = receiveWhatsAppWork({
        messages: [stalled, successor, ...unrelated],
        coordinator: {
          getByName: (): Pick<Fetcher, "fetch"> => ({
            fetch: (request) =>
              run(
                Effect.gen(function* () {
                  const work = yield* Schema.decodeUnknownEffect(WhatsAppWork)(
                    yield* Effect.tryPromise(() => new Request(request).json())
                  );
                  starts.push(work.turnId);
                  if (work.turnId === stalled.body.turnId) {
                    yield* Effect.tryPromise(() => gate.promise);
                  }
                  return new Response(null, { status: 200 });
                })
              ),
          }),
        },
      });
      try {
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => {
            for (const message of unrelated) expect(message.ack).toHaveBeenCalledOnce();
          })
        );
        expect(starts).not.toContain(successor.body.turnId);
        expect(stalled.ack).not.toHaveBeenCalled();
        expect(successor.ack).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
      }
      yield* Effect.tryPromise(() => running);
      expect(stalled.ack).toHaveBeenCalledOnce();
      expect(successor.ack).toHaveBeenCalledOnce();
      expect(starts.indexOf(stalled.body.turnId)).toBeLessThan(
        starts.indexOf(successor.body.turnId)
      );
    })
  ));
