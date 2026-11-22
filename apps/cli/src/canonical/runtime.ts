import { FidyApi, type FidyApiGroups, makeTokenAuthorizationClientLive } from "@fidy/server/client";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpApi, HttpApiClient, type HttpApiEndpoint, type HttpApiGroup } from "effect/http-api";
import { protectedHttpClient } from "../direct-client/runtime";
import { CliFailure, apiOrigin } from "../credential/contract";
import type { CanonicalClient, CanonicalClientFactory } from "./contract";

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

export const canonicalClientFactory: CanonicalClientFactory = Effect.fn(function* (options) {
  const authorization = yield* Layer.build(
    makeTokenAuthorizationClientLive(Redacted.value(options.credential.bearer))
  );

  const httpClient = protectedHttpClient({
    client: options.httpClient,
    allowQuery: true,
    maximumResponseBytes: 1_048_576,
    maximumRequestBytes: maximumInputBytes,
    captureRetry: options.captureRetry,
    captureAllowance: options.captureAllowance,
    captureTrace: options.captureTrace,
  });

  const entries = yield* Effect.forEach(Object.values(FidyApi.groups), (group) => {
    const declaration: CanonicalGroup = group;

    const api = HttpApi.make(FidyApi.identifier)
      .add(declaration)
      .annotateMerge(FidyApi.annotations);

    return HttpApiClient.group(api, {
      group: group.identifier,
      httpClient,
      baseUrl: apiOrigin,
    }).pipe(
      Effect.provideContext(authorization),
      Effect.map((methods): [string, CanonicalClient[string]] => [group.identifier, methods])
    );
  });

  const client: Record<string, CanonicalClient[string]> = Object.fromEntries(entries);

  return client;
});

const maximumInputBytes = 65_536;

const releaseInputReader = (
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "cancel" | "releaseLock">
): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      reader.cancel().catch(() => undefined);
    } finally {
      reader.releaseLock();
    }
  });

export const makeInputReader = (
  open: (path: string) => ReadableStream<unknown>
): ((path: string) => Effect.Effect<string, CliFailure>) =>
  Effect.fn(function* (path: string) {
    const stream = yield* Effect.try({
      try: () => open(path),
      catch: () => new CliFailure({ reason: "InvalidInput", cause: Option.none() }),
    });

    const chunks: Array<Uint8Array> = [];
    let size = 0;
    yield* Effect.gen(function* () {
      const reader = yield* Effect.acquireRelease(
        Effect.try({
          try: () => stream.getReader(),
          catch: () => new CliFailure({ reason: "InvalidInput", cause: Option.none() }),
        }),
        releaseInputReader
      );

      while (size <= maximumInputBytes) {
        const next = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: () => new CliFailure({ reason: "InvalidInput", cause: Option.none() }),
        });

        if (next.done) break;

        const bytes = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(next.value).pipe(
          Effect.mapError(
            (cause) => new CliFailure({ reason: "InvalidInput", cause: Option.some(cause) })
          )
        );

        size += bytes.byteLength;

        if (size <= maximumInputBytes && bytes.byteLength > 0) chunks.push(bytes);
      }
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(new CliFailure({ reason: "InvalidInput", cause: Option.none() })),
      })
    );

    if (size > maximumInputBytes) {
      return yield* new CliFailure({ reason: "InputTooLarge", cause: Option.none() });
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => new CliFailure({ reason: "InvalidInput", cause: Option.none() }),
    });
  });

export const readOperationInput = makeInputReader((path) =>
  path === "-" ? Bun.stdin.stream() : Bun.file(path).stream()
);
