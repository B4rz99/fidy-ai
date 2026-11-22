import { Effect, Schema } from "effect";

const request = Schema.Struct({
  url: Schema.String,
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.NullOr(Schema.String),
});

export default {
  fetch(input: Request, { INGRESS }: { INGRESS: Fetcher }): Promise<Response> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const call = yield* Schema.decodeUnknownEffect(request)(
          yield* Effect.tryPromise(() => input.json())
        );

        return yield* Effect.tryPromise(() =>
          INGRESS.fetch(call.url, {
            method: call.method,
            headers: call.headers,
            body: call.body,
          })
        );
      })
    );
  },
};
