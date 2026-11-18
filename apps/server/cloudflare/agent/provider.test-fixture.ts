import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Deferred, Effect, Schema } from "effect";

type Environment = { CONTROL: DurableObjectNamespace };
const completion = (content: string): Response =>
  Response.json({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
export class HostedProviderControl extends DurableObject {
  private readonly released = Deferred.makeUnsafe<void>();
  private waiting = false;
  private rounds = 0;
  private forget = false;
  private connection = false;
  private sends = 0;
  private correlation = "";
  private readonly inference = Effect.fn({ self: this }, function* (request: Request) {
    const input = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ response_format: Schema.optionalKey(Schema.Unknown) })
    )(yield* Effect.tryPromise(() => request.json()));
    if (input.response_format !== undefined) {
      return completion('{"compactedConversation":"Resumen anterior."}');
    }
    this.rounds += 1;
    if (this.rounds !== 1) return completion("Listo.");
    this.waiting = true;
    yield* Deferred.await(this.released);
    this.waiting = false;
    const message = {
      role: "assistant",
      content: null,
      tool_calls: this.connection
        ? [
            {
              id: "discover-bank",
              type: "function",
              function: { name: "connections__listInstitutions", arguments: "{}" },
            },
            {
              id: "connect-bank",
              type: "function",
              function: {
                name: "connections__connectInstitution",
                arguments: '{"payload":{"institutionId":"bancolombia"}}',
              },
            },
          ]
        : [
            {
              id: "first-call",
              type: "function",
              function: this.forget
                ? {
                    name: "memory__forget",
                    arguments: '{"params":{"id":"22460000-0000-4000-8000-000000000020"}}',
                  }
                : { name: "memory__recall", arguments: "{}" },
            },
          ],
    };
    return Response.json({
      choices: [{ message, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  });
  override fetch(request: Request): Promise<Response> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const path = new URL(request.url).pathname;
        if (path === "/connect") {
          this.connection = true;
          return new Response(null, { status: 204 });
        }
        if (path === "/forget") {
          this.forget = true;
          return new Response(null, { status: 204 });
        }
        if (path === "/sends") {
          return Response.json({ sends: this.sends, correlation: this.correlation });
        }
        if (new URL(request.url).hostname === "api.kapso.ai") {
          const body = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ biz_opaque_callback_data: Schema.String })
          )(yield* Effect.tryPromise(() => request.json()));
          this.sends += 1;
          this.correlation = body.biz_opaque_callback_data;
          return new Response(null, { status: 503 });
        }
        if (path === "/waiting") {
          return Response.json({ waiting: this.waiting, rounds: this.rounds });
        }
        if (path === "/release") {
          yield* Deferred.succeed(this.released, undefined);
          return new Response(null, { status: 204 });
        }
        if (request.url !== "https://api.openai.com/v1/chat/completions") {
          return new Response(null, { status: 404 });
        }
        return yield* this.inference(request);
      })
    );
  }
}
export class HostedProviderFixture extends WorkerEntrypoint<Environment> {
  override fetch(request: Request): Promise<Response> {
    return this.env.CONTROL.getByName("provider").fetch(request);
  }
}
export default HostedProviderFixture;
