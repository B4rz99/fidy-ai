import { FidyApi, type FidyApiGroups, makeTokenAuthorizationClientLive } from "@fidy/server/client";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpApi, HttpApiClient, type HttpApiEndpoint, type HttpApiGroup } from "effect/http-api";
import { makeProtectedClient } from "../direct-client/runtime";
import { CliFailure, apiOrigin } from "../credential/contract";
import type { CanonicalClient, CanonicalClientFactory } from "./contract";

// Erase decoded value types on the declaration, where assignability is checked. Generated
// methods still encode through the original endpoint schemas before executing any request.
type CanonicalEndpoint = HttpApiEndpoint.ConstraintRequest & {
  readonly "~Params": Schema.ConstraintCodec<unknown, unknown>;
  readonly "~Query": Schema.ConstraintCodec<unknown, unknown>;
  readonly "~Payload": Schema.ConstraintCodec<unknown, unknown>;
  readonly "~Headers": Schema.ConstraintCodec<unknown, unknown>;
  readonly "~Success": Schema.ConstraintCodec<unknown, unknown>;
  readonly "~Error": Schema.ConstraintCodec<object, unknown>;
  readonly "~Middleware": HttpApiEndpoint.Middleware<HttpApiGroup.Endpoints<FidyApiGroups>>;
};
type CanonicalGroup = HttpApiGroup.Constraint & {
  readonly topLevel: false;
  readonly endpoints: Readonly<Record<string, CanonicalEndpoint>>;
};

/** Per-invocation derived client: bearer authority never enters an ambient shared transport. */
export const makeCanonicalClient: CanonicalClientFactory = Effect.fn(function* (options) {
  const authorization = yield* Layer.build(
    makeTokenAuthorizationClientLive(Redacted.value(options.credential.bearer))
  );
  const httpClient = makeProtectedClient({
    client: options.httpClient,
    allowQuery: true,
    maximumResponseBytes: 1_048_576,
    maximumRequestBytes: maximumInputBytes,
    captureRetry: options.captureRetry,
    captureAllowance: options.captureAllowance,
  });
  const client: Record<string, CanonicalClient[string]> = {};
  for (const group of Object.values(FidyApi.groups)) {
    const declaration: CanonicalGroup = group;
    const api = HttpApi.make(FidyApi.identifier)
      .add(declaration)
      .annotateMerge(FidyApi.annotations);
    const methods = yield* HttpApiClient.group(api, {
      group: group.identifier,
      httpClient,
      baseUrl: apiOrigin,
    }).pipe(Effect.provideContext(authorization));
    client[group.identifier] = methods;
  }
  return client;
});

const maximumInputBytes = 65_536;

const releaseInputReader = (
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "cancel" | "releaseLock">
): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      // Input cancellation may never settle; local ownership must still end.
      reader.cancel().catch(() => undefined);
    } finally {
      reader.releaseLock();
    }
  });

/** Owns input acquisition, byte/deadline budgets and reader cleanup over an OS input adapter. */
export const makeInputReader = (
  open: (path: string) => ReadableStream<unknown>
): ((path: string) => Effect.Effect<string, CliFailure>) =>
  Effect.fn(function* (path: string) {
    const stream = yield* Effect.try({
      try: () => open(path),
      catch: () => new CliFailure({ reason: "InvalidInput" }),
    });
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    yield* Effect.gen(function* () {
      const reader = yield* Effect.acquireRelease(
        Effect.try({
          try: () => stream.getReader(),
          catch: () => new CliFailure({ reason: "InvalidInput" }),
        }),
        releaseInputReader
      );
      while (size <= maximumInputBytes) {
        const next = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: () => new CliFailure({ reason: "InvalidInput" }),
        });
        if (next.done) break;
        const bytes = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(next.value).pipe(
          Effect.mapError(() => new CliFailure({ reason: "InvalidInput" }))
        );
        size += bytes.byteLength;
        if (size <= maximumInputBytes && bytes.byteLength > 0) chunks.push(bytes);
      }
    }).pipe(
      Effect.scoped,
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
