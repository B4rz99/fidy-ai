import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { expect } from "vitest";
import { receiveForwardedEmailWork } from "./runtime";

const heldFetchResponse = (
  release: Deferred.Deferred<void>,
  status: number,
  finished: () => void
): Promise<Response> =>
  Effect.runPromise(
    Deferred.await(release).pipe(
      Effect.as(new Response(null, { status })),
      Effect.ensuring(Effect.sync(finished))
    )
  );

it.live("bounds coordinator deliveries while leaving failed messages eligible for redelivery", () =>
  Effect.gen(function* () {
    const firstWave = yield* Deferred.make<void>();
    const pending = yield* Deferred.make<void>();
    let active = 0;
    let peak = 0;
    const acknowledged: number[] = [];
    const messages = Array.from({ length: 12 }, (_, index) => ({
      body: {
        userId: "10000000-0000-4000-8000-000000000101",
        receiptId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      },
      ack: (): void => {
        acknowledged.push(index);
      },
    }));
    let requested = 0;
    const coordinator = {
      getByName: (): Pick<Fetcher, "fetch"> => ({
        fetch: (): Promise<Response> => {
          const index = requested++;
          active += 1;
          peak = Math.max(peak, active);
          if (active === 4) Deferred.doneUnsafe(firstWave, Effect.void);
          return heldFetchResponse(pending, index === 0 ? 503 : 200, () => {
            active -= 1;
          });
        },
      }),
    };
    const delivery = yield* Effect.tryPromise(() =>
      receiveForwardedEmailWork({ messages, coordinator })
    ).pipe(Effect.exit, Effect.forkScoped);
    yield* Effect.ensuring(
      Deferred.await(firstWave).pipe(Effect.timeout("5 seconds")),
      Deferred.succeed(pending, undefined)
    );
    const outcome = yield* Fiber.join(delivery);
    expect(outcome._tag).toBe("Failure");
    expect(peak).toBeLessThanOrEqual(4);
    expect(requested).toBe(12);
    expect(acknowledged.toSorted((left, right) => left - right)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1)
    );
  })
);
