import { Data, Effect, Option, Schema } from "effect";
import { type BoundedBodyReadFailed } from "../http/contract";
import { awaitRequestAbort, collectBoundedRequestBody } from "../http/operations";

const maximumInputBytes = Number("5242880");

const maximumOutputBytes = Number("1048576");

const maximumImageDimension = Number("10000");

const maximumImagePixels = Number("40000000");

const pngHeaderBytes = Number("24");

const pngChunkNameStart = Number("12");

const pngChunkNameEnd = Number("16");

const pngWidthOffset = Number("16");

const pngHeightOffset = Number("20");

const pdfSignature = new TextEncoder().encode("%PDF-");

const pdfEndMarker = new TextEncoder().encode("%%EOF");

const pdfEncryptionMarker = new TextEncoder().encode("/Encrypt");

const pngSignature = Uint8Array.fromBase64("iVBORw0KGgo=");

export const documentExtractionLimits = {
  maximumImageDimension,
  maximumImagePixels,
  maximumInputBytes,
  maximumOutputBytes,
} as const;

const ConversionResults = Schema.Tuple([
  Schema.Union([
    Schema.Struct({ data: Schema.String, format: Schema.Literal("markdown") }),
    Schema.Struct({ error: Schema.String, format: Schema.Literal("error") }),
  ]),
]);

type DocumentExtractionBindings = {
  readonly AI: {
    readonly toMarkdown: (
      documents: ReadonlyArray<{ readonly blob: Blob; readonly name: string }>
    ) => Promise<Schema.Json>;
  };
};

type InputDocument = {
  readonly mime: "application/pdf" | "image/png";
  readonly name: "statement.pdf" | "statement.png";
};

type RejectionReason =
  | BoundedBodyReadFailed["reason"]
  | "conversion-failed"
  | "not-found"
  | "password-required"
  | "unsupported-format";

class ExtractionRejected extends Data.TaggedError("ExtractionRejected")<{
  readonly reason: RejectionReason;
  readonly cause: Option.Option<unknown>;
}> {}

const statusByReason = {
  cancelled: 499,
  "conversion-failed": 422,
  "malformed-file": 422,
  "not-found": 404,
  "password-required": 422,
  "resource-limit": 413,
  "unsupported-format": 422,
} as const satisfies Record<RejectionReason, number>;

const failureResponse = (reason: RejectionReason): Response =>
  Response.json({ outcome: "rejected", reason }, { status: statusByReason[reason] });

const startsWith = (bytes: Uint8Array, signature: Uint8Array): boolean =>
  signature.every((value, index) => bytes[index] === value);

const containsSequence = (bytes: Uint8Array, sequence: Uint8Array): boolean => {
  const finalStart = bytes.byteLength - sequence.byteLength;

  for (let start = 0; start <= finalStart; start += 1) {
    if (sequence.every((value, index) => bytes[start + index] === value)) return true;
  }

  return false;
};

const readPngInput = (bytes: Uint8Array): Effect.Effect<InputDocument, ExtractionRejected> => {
  if (bytes.byteLength < pngHeaderBytes) {
    return Effect.fail(new ExtractionRejected({ reason: "malformed-file", cause: Option.none() }));
  }

  const chunkName = new TextDecoder().decode(bytes.subarray(pngChunkNameStart, pngChunkNameEnd));

  if (chunkName !== "IHDR") {
    return Effect.fail(new ExtractionRejected({ reason: "malformed-file", cause: Option.none() }));
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(pngWidthOffset);
  const height = view.getUint32(pngHeightOffset);

  if (width === 0 || height === 0) {
    return Effect.fail(new ExtractionRejected({ reason: "malformed-file", cause: Option.none() }));
  }

  if (
    width > maximumImageDimension ||
    height > maximumImageDimension ||
    width * height > maximumImagePixels
  ) {
    return Effect.fail(new ExtractionRejected({ reason: "resource-limit", cause: Option.none() }));
  }

  return Effect.succeed({ mime: "image/png", name: "statement.png" });
};

const detectInput = Effect.fn(function* (bytes: Uint8Array) {
  if (startsWith(bytes, pdfSignature)) {
    if (!containsSequence(bytes, pdfEndMarker)) {
      return yield* new ExtractionRejected({ reason: "malformed-file", cause: Option.none() });
    }

    if (containsSequence(bytes, pdfEncryptionMarker)) {
      return yield* new ExtractionRejected({ reason: "password-required", cause: Option.none() });
    }

    return { mime: "application/pdf", name: "statement.pdf" } as const;
  }

  if (startsWith(bytes, pngSignature)) {
    return yield* readPngInput(bytes);
  }

  return yield* new ExtractionRejected({ reason: "unsupported-format", cause: Option.none() });
});

const convertRequest = Effect.fn(function* (
  request: Request,
  bindings: DocumentExtractionBindings
) {
  const startedAt = performance.now();
  const bytes = yield* collectBoundedRequestBody(request, maximumInputBytes);
  const input = yield* detectInput(bytes);
  const blobBytes = new Uint8Array(bytes).buffer;

  const conversion = yield* Effect.raceFirst(
    Effect.tryPromise({
      catch: () => new ExtractionRejected({ reason: "conversion-failed", cause: Option.none() }),
      try: () =>
        bindings.AI.toMarkdown([
          { blob: new Blob([blobBytes], { type: input.mime }), name: input.name },
        ]),
    }),
    awaitRequestAbort(request)
  );

  const [result] = yield* Schema.decodeUnknownEffect(ConversionResults)(conversion).pipe(
    Effect.mapError(
      (cause) => new ExtractionRejected({ reason: "conversion-failed", cause: Option.some(cause) })
    )
  );

  if (result.format !== "markdown") {
    return yield* new ExtractionRejected({ reason: "conversion-failed", cause: Option.none() });
  }

  if (result.data.length > maximumOutputBytes) {
    return yield* new ExtractionRejected({ reason: "resource-limit", cause: Option.none() });
  }

  const outputBytes = new TextEncoder().encode(result.data).byteLength;

  if (outputBytes > maximumOutputBytes) {
    return yield* new ExtractionRejected({ reason: "resource-limit", cause: Option.none() });
  }

  return Response.json({
    elapsedMilliseconds: performance.now() - startedAt,
    outcome: "converted",
    outputBytes,
  });
});

const fetch = (request: Request, bindings: DocumentExtractionBindings): Promise<Response> => {
  const url = new URL(request.url);

  if (request.method !== "POST" || url.pathname !== "/extract") {
    return Promise.resolve(failureResponse("not-found"));
  }

  return convertRequest(request, bindings).pipe(
    Effect.match({
      onFailure: (failure) => failureResponse(failure.reason),
      onSuccess: (response) => response,
    }),
    Effect.runPromise
  );
};

export const documentExtractionWorker = { fetch };

export default documentExtractionWorker;
