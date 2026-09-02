import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  type BoundedExternalHttpResponse,
  type ExternalHttpFailure,
  makeBoundedExternalHttpClient,
} from "./bounded-external-http";

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

const execute = (
  response: Response,
  maximumBytes: number
): Effect.Effect<BoundedExternalHttpResponse, ExternalHttpFailure> => {
  const transport = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, response))
  );
  return transport
    .pipe(makeBoundedExternalHttpClient("kapso"))
    .execute(HttpClientRequest.get("https://provider.example/response"), maximumBytes);
};

it.effect(
  "accepts a provider response exactly at the streamed byte limit without a declared length",
  () =>
    Effect.gen(function* () {
      const response = yield* execute(
        chunkedResponse({
          chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
          headers: {},
          onCancel: () => undefined,
          close: true,
        }),
        4
      );

      expect(response.body).toEqual(new Uint8Array([1, 2, 3, 4]));
    })
);

it.effect("rejects a dishonest smaller content length when streamed bytes cross the limit", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const failure = yield* execute(
      chunkedResponse({
        chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])],
        headers: { "content-length": "1" },
        onCancel: () => {
          cancelled = true;
        },
        close: false,
      }),
      4
    ).pipe(Effect.flip);

    expect(failure.reason).toBe("response-too-large");
    expect(cancelled).toBe(true);
  })
);

it.effect("rejects a declared or chunked overflow and cancels the owned response stream", () =>
  Effect.gen(function* () {
    for (const declaredLength of ["5", undefined]) {
      let cancelled = false;
      const headers: Readonly<Record<string, string>> =
        declaredLength === undefined ? {} : { "content-length": declaredLength };
      const failure = yield* execute(
        chunkedResponse({
          chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
          headers,
          onCancel: () => {
            cancelled = true;
          },
          close: false,
        }),
        4
      ).pipe(Effect.flip);

      expect(failure.reason).toBe("response-too-large");
      expect(cancelled).toBe(true);
    }
  })
);

it.effect("sanitizes a response stream failure", () =>
  Effect.gen(function* () {
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: (controller): void => {
          pulls += 1;
          if (pulls === 1) controller.enqueue(new Uint8Array([1]));
          else controller.error(new Error("response-private-sentinel"));
        },
      })
    );

    const failure = yield* execute(response, 4).pipe(Effect.flip);

    expect(failure.reason).toBe("response-body-failed");
    expect(String(failure)).not.toContain("response-private-sentinel");
  })
);

it.effect("cancels an owned provider reader when bounded reading is interrupted", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start: (controller): void => controller.enqueue(new Uint8Array([1])),
        pull: (): void => undefined,
        cancel: (): void => {
          cancelled = true;
        },
      })
    );
    const fiber = yield* execute(response, 4).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;

    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(cancelled).toBe(true);
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  })
);
