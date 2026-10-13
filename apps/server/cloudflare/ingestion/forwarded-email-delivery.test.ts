import { it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Option, Schema } from "effect";
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

it.live(
  "forwards only validated fresh correlation while malformed metadata never rejects domain work",
  () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const traceId = "0123456789abcdef0123456789abcdef";
      const spanId = "0123456789abcdef";
      const headers: Array<Option.Option<string>> = [];
      const forwarded: Request[] = [];
      let acknowledged = 0;
      const contexts = [
        {
          version: 1,
          traceId,
          parentSpanId: spanId,
          sampled: true,
          capturedAtUnixMilliseconds: now,
        },
        {
          version: 1,
          traceId: "private-user-credential",
          parentSpanId: spanId,
          sampled: true,
          capturedAtUnixMilliseconds: now,
        },
        {
          version: 1,
          traceId,
          parentSpanId: spanId,
          sampled: true,
          capturedAtUnixMilliseconds: now - 86_400_001,
        },
        {
          version: 1,
          traceId,
          parentSpanId: spanId,
          sampled: true,
          capturedAtUnixMilliseconds: now,
          credentials: "secret-body-content-sentinel",
        },
      ];
      yield* Effect.tryPromise(() =>
        receiveForwardedEmailWork({
          messages: contexts.map((traceContext) => ({
            body: {
              userId: "10000000-0000-4000-8000-000000000101",
              receiptId: "10000000-0000-4000-8000-000000000102",
              traceContext,
            },
            ack: (): void => {
              acknowledged++;
            },
          })),
          coordinator: {
            getByName: (): Pick<Fetcher, "fetch"> => ({
              fetch: (request): Promise<Response> => {
                forwarded.push(new Request(request));
                headers.push(
                  Option.fromNullOr(new Request(request).headers.get("x-fidy-traceparent"))
                );
                return Promise.resolve(new Response(null, { status: 200 }));
              },
            }),
          },
        })
      );
      expect(acknowledged).toBe(4);
      expect(headers.flatMap((header) => Option.toArray(header))).toEqual([
        `00-${traceId}-${spanId}-01`,
      ]);
      const bodies = yield* Effect.forEach(forwarded, (request) =>
        Effect.tryPromise(() => request.text()).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown)))
        )
      );
      const identity = {
        userId: "10000000-0000-4000-8000-000000000101",
        receiptId: "10000000-0000-4000-8000-000000000102",
      };
      expect(bodies).toEqual([
        { ...identity, traceContext: contexts[0] },
        identity,
        identity,
        identity,
      ]);
    })
);
