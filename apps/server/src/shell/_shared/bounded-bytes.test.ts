import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { collectBoundedResponseBytes } from "./bounded-bytes";

const providerResponse = (response: Response): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(HttpClientRequest.get("https://provider.example/response"), response);

type ChunkedResponse = Readonly<{
  chunks: ReadonlyArray<Uint8Array>;
  headers: Readonly<Record<string, string>>;
  onCancel: () => void;
  close: boolean;
}>;

const chunkedResponse = ({ chunks, headers, onCancel, close }: ChunkedResponse): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start: (controller): void => {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (close) controller.close();
      },
      cancel: onCancel,
    }),
    { headers }
  );

it.effect(
  "accepts a provider response exactly at the streamed byte limit without a declared length",
  () =>
    Effect.gen(function* () {
      const bytes = yield* collectBoundedResponseBytes(
        providerResponse(
          chunkedResponse({
            chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
            headers: {},
            onCancel: () => undefined,
            close: true,
          })
        ),
        4
      );

      expect(Option.getOrThrow(bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
    })
);

it.effect("rejects a dishonest smaller content length when streamed bytes cross the limit", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const bytes = yield* collectBoundedResponseBytes(
      providerResponse(
        chunkedResponse({
          chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])],
          headers: { "content-length": "1" },
          onCancel: () => {
            cancelled = true;
          },
          close: false,
        })
      ),
      4
    );

    expect(Option.isNone(bytes)).toBe(true);
    expect(cancelled).toBe(true);
  })
);

it.effect("rejects a declared or chunked overflow and cancels the owned response stream", () =>
  Effect.gen(function* () {
    for (const declaredLength of ["5", undefined]) {
      let cancelled = false;
      const headers: Readonly<Record<string, string>> =
        declaredLength === undefined ? {} : { "content-length": declaredLength };
      const bytes = yield* collectBoundedResponseBytes(
        providerResponse(
          chunkedResponse({
            chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
            headers,
            onCancel: () => {
              cancelled = true;
            },
            close: false,
          })
        ),
        4
      );

      expect(Option.isNone(bytes)).toBe(true);
      expect(cancelled).toBe(true);
    }
  })
);

it.effect("cancels an owned provider reader when bounded reading is interrupted", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const response = providerResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller): void => controller.enqueue(new Uint8Array([1])),
          pull: (): void => undefined,
          cancel: (): void => {
            cancelled = true;
          },
        })
      )
    );
    const fiber = yield* collectBoundedResponseBytes(response, 4).pipe(
      Effect.forkChild({ startImmediately: true })
    );
    yield* Effect.yieldNow;

    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(cancelled).toBe(true);
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  })
);
