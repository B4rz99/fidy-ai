import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Deferred, Effect, Schema } from "effect";

type Environment = { CONTROL: DurableObjectNamespace };
const completion = (content: string): Response =>
  Response.json({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
const fixtureTool = (mode: string): { name: string; arguments: string } => {
  const id = "22460000-0000-4000-8000-000000000020";
  if (mode === "/batch") {
    return {
      name: "operations__executeAtomicBatch",
      arguments: JSON.stringify({
        payload: {
          calls: [
            {
              callId: "22460000-0000-4000-8000-000000000011",
              operation: "memory.forget",
              input: { params: { id } },
            },
            {
              callId: "22460000-0000-4000-8000-000000000012",
              operation: "dashboard.initializeDashboard",
              input: {},
            },
            {
              callId: "22460000-0000-4000-8000-000000000013",
              operation: "ingestion.enableEmailForwarding",
              input: {},
            },
          ],
        },
      }),
    };
  }
  if (mode === "/forget") {
    return { name: "memory__forget", arguments: JSON.stringify({ params: { id } }) };
  }
  return { name: "memory__recall", arguments: "{}" };
};

export class HostedProviderControl extends DurableObject {
  private readonly released = Deferred.makeUnsafe<void>();
  private waiting = false;
  private rounds = 0;
  private mode = "/recall";
  private requested: ReadonlyArray<{ name: string; arguments: string }> = [];
  private available: ReadonlyArray<string> = [];
  private sends = 0;
  private correlation = "";
  private readonly inference = Effect.fn({ self: this }, function* (request: Request) {
    const input = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        response_format: Schema.optionalKey(Schema.Unknown),
        tools: Schema.optionalKey(
          Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) }))
        ),
      })
    )(yield* Effect.tryPromise(() => request.json()));
    if (input.response_format !== undefined) {
      return completion('{"compactedConversation":"Resumen anterior."}');
    }
    this.available = input.tools?.map((tool) => tool.function.name) ?? [];
    this.rounds += 1;
    if (this.rounds !== 1) return completion("Listo.");
    this.waiting = true;
    yield* Deferred.await(this.released);
    this.waiting = false;
    if (this.mode === "/malformed") {
      return Response.json({
        choices: [
          { message: { role: "assistant", content: { invalid: true } }, finish_reason: "stop" },
        ],
      });
    }
    const message = {
      role: "assistant",
      content: null,
      tool_calls:
        this.requested.length > 0
          ? this.requested.map((tool, index) => ({
              id: "query-" + index,
              type: "function",
              function: tool,
            }))
          : [
              {
                id: "first-call",
                type: "function",
                function: fixtureTool(this.mode),
              },
            ],
    };
    return Response.json({
      choices: [{ message, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  });
  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/tools") {
      if (request.method !== "POST") return Promise.resolve(Response.json(this.available));
      return Effect.runPromise(
        Effect.gen({ self: this }, function* () {
          this.requested = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ name: Schema.String, arguments: Schema.String }))
          )(yield* Effect.tryPromise(() => request.json()));
          return new Response(null, { status: 204 });
        })
      );
    }
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const path = new URL(request.url).pathname;
        if (path === "/connect") {
          this.requested = [
            { name: "connections__listInstitutions", arguments: "{}" },
            {
              name: "connections__connectInstitution",
              arguments: '{"payload":{"institutionId":"bancolombia"}}',
            },
          ];
          return new Response(null, { status: 204 });
        }
        if (["/batch", "/forget", "/malformed"].includes(path)) {
          this.mode = path;
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
