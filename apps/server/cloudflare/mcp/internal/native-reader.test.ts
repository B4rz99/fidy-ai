import { expect, it } from "@effect/vitest";
import { Data, Effect, Exit } from "effect";
import { leaseNativeReader } from "./native-reader";

class FixtureRefusal extends Data.TaggedError("FixtureRefusal")<{}> {}

it.effect("releases the SDK reader and resident lease once after normal completion", () =>
  Effect.gen(function* () {
    const body = new ReadableStream<Uint8Array>({
      start: (controller): void => controller.close(),
    });
    const reader = body.getReader();
    let leasesReleased = 0;
    const lifetime = leaseNativeReader({
      reader,
      releaseLease: (): void => {
        leasesReleased += 1;
      },
    });
    expect((yield* Effect.tryPromise(() => reader.read())).done).toBe(true);
    lifetime.finish();
    lifetime.finish();
    yield* Effect.tryPromise(() => lifetime.cancel());
    expect(body.locked).toBe(false);
    expect(leasesReleased).toBe(1);
  })
);

it.effect("keeps SDK ownership until shared cancellation settles, then unlocks the reader", () =>
  Effect.gen(function* () {
    const { promise: cancelled, resolve: completeCancellation } = Promise.withResolvers<void>();
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel: (): Promise<void> => {
        cancellations += 1;
        return cancelled;
      },
    });
    let leasesReleased = 0;
    const lifetime = leaseNativeReader({
      reader: body.getReader(),
      releaseLease: (): void => {
        leasesReleased += 1;
      },
    });
    const pending = lifetime.cancel();
    expect(lifetime.cancel()).toBe(pending);
    yield* Effect.tryPromise(() => Promise.resolve());
    lifetime.finish();
    expect(body.locked).toBe(true);
    expect(leasesReleased).toBe(0);
    completeCancellation();
    yield* Effect.tryPromise(() => pending);
    expect(body.locked).toBe(false);
    expect(leasesReleased).toBe(1);
    expect(cancellations).toBe(1);
  })
);

it.effect("releases the reader when SDK cancellation rejects, preserving the refusal", () =>
  Effect.gen(function* () {
    const refusal = new Error("SDK cancellation refused");
    const body = new ReadableStream<Uint8Array>({
      cancel: (): Promise<void> => Promise.reject(refusal),
    });
    let leasesReleased = 0;
    const lifetime = leaseNativeReader({
      reader: body.getReader(),
      releaseLease: (): void => {
        leasesReleased += 1;
      },
    });
    const result = yield* Effect.tryPromise({
      try: () => lifetime.cancel(),
      catch: (error) => (error instanceof FixtureRefusal ? error : refusal),
    }).pipe(Effect.exit);
    expect(result).toEqual(Exit.fail(refusal));
    expect(body.locked).toBe(false);
    expect(leasesReleased).toBe(1);
  })
);
