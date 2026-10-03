import { FidyApi, makeTokenAuthorizationClientLive } from "@fidy/server/client";
import { Effect, Layer, Redacted, Stream } from "effect";
import { HttpApiClient } from "effect/http-api";
import { makeProtectedClient } from "../direct-client/runtime";
import { CliFailure, apiOrigin } from "../credential/contract";
import type { CanonicalClient, CanonicalClientFactory } from "./contract";
/** Per-invocation derived client: bearer authority never enters an ambient shared transport. */
export const makeCanonicalClient: CanonicalClientFactory = Effect.fn(function* (options) {
  const authorization = yield* Layer.build(
    makeTokenAuthorizationClientLive(Redacted.value(options.credential.bearer))
  );
  const client = yield* HttpApiClient.makeWith(FidyApi, {
    httpClient: makeProtectedClient({
      client: options.httpClient,
      allowQuery: true,
      maximumResponseBytes: 1_048_576,
      maximumRequestBytes: maximumInputBytes,
      captureRetry: options.captureRetry,
    }),
    baseUrl: apiOrigin,
  }).pipe(Effect.provideContext(authorization));
  // The static union cannot express selection by runtime id. This single bridge is safe only
  // after invokeOperation selects the same catalog id and decodes that operation's complete input.
  // Every result/failure crosses the selected codec again before it can leave the invocation.
  return client as unknown as CanonicalClient;
});

const maximumInputBytes = 65_536;

/** Owns input acquisition, byte/deadline budgets and reader cleanup over an OS input adapter. */
export const makeInputReader = (
  open: (path: string) => ReadableStream<Uint8Array>
): ((path: string) => Effect.Effect<string, CliFailure>) =>
  Effect.fn(function* (path: string) {
    const stream = yield* Effect.try({
      try: () => open(path),
      catch: () => new CliFailure({ reason: "InvalidInput" }),
    });
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    yield* Stream.fromReadableStream({
      evaluate: () => stream,
      onError: () => new CliFailure({ reason: "InvalidInput" }),
    }).pipe(
      Stream.runForEachWhile((chunk) =>
        Effect.sync(() => {
          size += chunk.byteLength;
          if (size > maximumInputBytes) return false;
          chunks.push(chunk);
          return true;
        })
      ),
      // Bun can throw synchronously while getReader opens a missing file; treat that foreign
      // acquisition rejection exactly like a streamed read failure, not an application defect.
      Effect.catchDefect(() => Effect.fail(new CliFailure({ reason: "InvalidInput" }))),
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(new CliFailure({ reason: "InvalidInput" })),
      })
    );
    if (size > maximumInputBytes) return yield* new CliFailure({ reason: "InputTooLarge" });
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => new CliFailure({ reason: "InvalidInput" }),
    });
  });

/** Production has no implicit stdin: only an explicit '-' selects the process input stream. */
export const readOperationInput = makeInputReader((path) =>
  path === "-" ? Bun.stdin.stream() : Bun.file(path).stream()
);
