import { Effect, Schema } from "effect";

const Envelope = Schema.Struct({
  url: Schema.String,
  method: Schema.Literal("GET"),
  headers: Schema.Record(Schema.String, Schema.String),
});

/** Closed loopback operator transport to the actual named entry, never a public mode selector. */
export const assessmentDocumentOperator = (
  input: Readonly<{
    request: Request;
    read: (request: Request) => Promise<unknown>;
    incomingOrigin: string;
    logicalOrigin: string;
  }>
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise(() => input.request.json());
      const envelope = yield* Schema.decodeUnknownEffect(Envelope)(raw);
      const url = new URL(envelope.url);
      if (url.origin !== input.incomingOrigin || url.pathname !== "/app/dashboard") {
        return new Response(null, { status: 403 });
      }
      const logical = new URL(input.logicalOrigin);
      logical.pathname = url.pathname;
      logical.search = url.search;
      const headers = new Headers(envelope.headers);
      headers.set("cf-connecting-ip", headers.get("x-acceptance-source") ?? "127.0.0.1");
      headers.delete("x-acceptance-source");
      const reply = yield* Effect.tryPromise(() => input.read(new Request(logical, { headers })));
      return Response.json(reply, { headers: { "cache-control": "no-store" } });
    }).pipe(Effect.orElseSucceed(() => new Response(null, { status: 503 })))
  );
