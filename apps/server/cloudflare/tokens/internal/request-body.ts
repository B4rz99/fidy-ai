import { Effect, Option, Schema } from "effect";
import { RequestBodyPolicy } from "../../http/contract";
import { readBoundedRequestBody } from "../../http/operations";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2_000,
});

export const decodeRequestPayload = <Decoded, Encoded>({
  request,
  schema,
}: Readonly<{
  request: Request;
  schema: Schema.Codec<Decoded, Encoded>;
}>): Effect.Effect<Option.Option<Decoded>> =>
  Effect.gen(function* () {
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      return Option.none<Decoded>();
    }

    const bytes = yield* readBoundedRequestBody(request, policy);
    const text = yield* Effect.try(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text);

    return Schema.decodeUnknownOption(schema)(value);
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.orElseSucceed(() => Option.none<Decoded>())
  );
