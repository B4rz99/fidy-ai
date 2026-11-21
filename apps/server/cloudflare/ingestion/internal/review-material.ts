import { ReviewUnavailable } from "../contract";
import { Effect, Option, Schema } from "effect";
import PostalMime from "postal-mime";

const maximumEmailBytes = 1_048_576;

export const MaterialRow = Schema.Struct({
  text: Schema.OptionFromNullOr(Schema.String),
  object_key: Schema.OptionFromNullOr(Schema.String),
});

export const unavailable = { available: false, reason: "unavailable" } as const;

export const materialText = ({
  row,
  bucket,
}: Readonly<{ row: typeof MaterialRow.Type; bucket: Option.Option<R2Bucket> }>): Effect.Effect<
  Option.Option<string>,
  ReviewUnavailable
> =>
  Effect.gen(function* () {
    if (Option.isSome(row.text)) return row.text;

    if (Option.isNone(row.object_key) || Option.isNone(bucket)) return Option.none();
    const objectKey = row.object_key.value;
    const object = yield* Effect.tryPromise(() => bucket.value.get(objectKey));

    if (object === null || object.size > maximumEmailBytes) return Option.none();
    const bytes = yield* Effect.tryPromise(() => object.arrayBuffer());

    if (bytes.byteLength > maximumEmailBytes) return Option.none();
    const email = yield* Effect.tryPromise(() => PostalMime.parse(bytes));

    return Option.fromUndefinedOr(email.text ?? email.html);
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.mapError(() => new ReviewUnavailable())
  );
