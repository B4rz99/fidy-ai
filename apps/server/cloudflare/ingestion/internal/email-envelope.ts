import { Data, Effect, Predicate, Schema } from "effect";

export const maximumRawBytes = 1_048_576;

const millisecondsPerDay = 86_400_000;

const retentionDays = 90;

export const retentionMs = retentionDays * millisecondsPerDay;

export const maximumOutstandingUser = 100;

export const maximumRetainedUser = 1000;

export const recipientPattern = /^[a-z0-9_-]{24,64}@fidyapp\.com$/u;

export const maximumHeadersSize = 16_384;

export const maximumMimeDepth = 8;

export const maximumNestedMessageDepth = 0;

export class EmailUnavailable extends Data.TaggedError("EmailUnavailable")<{
  readonly reason: "authority" | "size" | "capacity";
}> {}

export const authorityUnavailable = (): EmailUnavailable =>
  new EmailUnavailable({ reason: "authority" });

export const io = <A>(tryWork: () => Promise<A>): Effect.Effect<A, EmailUnavailable> =>
  Effect.tryPromise({
    try: tryWork,
    catch: (cause) =>
      Predicate.isError(cause) && cause.message.includes("forwarded_email_deferred_capacity")
        ? new EmailUnavailable({ reason: "capacity" })
        : authorityUnavailable(),
  });

const releaseEmailReader = (reader: ReadableStreamDefaultReader<unknown>): Effect.Effect<void> =>
  Effect.sync(() => {
    reader.cancel().catch(() => undefined);
    reader.releaseLock();
  });

export const readBounded = Effect.fn(function* (raw: ReadableStream) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  yield* Effect.acquireUseRelease(
    Effect.try({ try: () => raw.getReader(), catch: authorityUnavailable }),
    Effect.fnUntraced(function* (reader) {
      let next = yield* io(() => reader.read());

      while (!next.done) {
        const chunk = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(next.value).pipe(
          Effect.mapError(authorityUnavailable)
        );

        size += chunk.byteLength;

        if (size > maximumRawBytes) return yield* new EmailUnavailable({ reason: "size" });

        if (chunk.byteLength > 0) chunks.push(chunk);
        next = yield* io(() => reader.read());
      }
    }),
    releaseEmailReader
  );
  const result = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
});
