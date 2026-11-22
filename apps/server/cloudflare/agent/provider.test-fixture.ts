import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Data, Deferred, Effect, Option, Schema } from "effect";

type Environment = { CONTROL: DurableObjectNamespace; INGRESS: Fetcher };

const browserBearerLength = 43;

const capacityTextLength = 2_000;

class BrowserRequestAborted extends Data.TaggedError("BrowserRequestAborted")<{
  readonly cause: unknown;
}> {}

class BrowserRequestFailed extends Data.TaggedError("BrowserRequestFailed")<{
  readonly cause: unknown;
}> {}

const completion = (content: string): Response =>
  Response.json({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });

type FixtureTool = Readonly<{ name: string; arguments: string }>;

const fixtureTool = (mode: string): FixtureTool => {
  const id = "22460000-0000-4000-8000-000000000020";

  if (mode === "/batch-capacity") {
    return {
      name: "operations__executeAtomicBatch",
      arguments: JSON.stringify({
        payload: {
          calls: [
            {
              callId: "22460000-0000-4000-8000-000000000011",
              operation: "memory.revise",
              input: {
                params: { id: "22460000-0000-4000-8000-000000000020" },
                payload: { text: "x".repeat(capacityTextLength) },
              },
            },
          ],
        },
      }),
    };
  }

  if (mode === "/batch" || mode === "/batch-absent") {
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

const textModes = [
  "/batch",
  "/batch-absent",
  "/batch-capacity",
  "/forget",
  "/malformed",
  "/repair-after-query",
  "/invalid-after-query",
  "/unavailable-after-query",
];

export class HostedProviderControl extends DurableObject<Environment> {
  private readonly browserClient = new AbortController();
  private readonly released = Deferred.makeUnsafe<void>();
  private waiting = false;
  private compactionMode = "valid";
  private compactionCalls = 0;
  private readonly resumeCompaction = Deferred.makeUnsafe<void>();
  private readonly structured = Effect.fn({ self: this }, function* () {
    this.compactionCalls += 1;

    if (this.compactionMode === "held") yield* Deferred.await(this.resumeCompaction);

    return completion(
      this.compactionMode === "invalid"
        ? '{"other":"Resumen"}'
        : '{"compactedConversation":"Resumen anterior."}'
    );
  });
  private readonly configureCompaction = Effect.fn({ self: this }, function* (request: Request) {
    if (request.method === "POST") {
      const action = yield* Effect.tryPromise(() => request.text());

      if (action === "release") yield* Deferred.succeed(this.resumeCompaction, undefined);
      else this.compactionMode = action;
    }

    return Response.json({ calls: this.compactionCalls });
  });
  private rounds = 0;
  private mode = "/recall";
  private requested: ReadonlyArray<{ name: string; arguments: string }> = [];
  private available: ReadonlyArray<string> = [];
  private sends = 0;
  private readonly templates: string[] = [];
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
      return yield* this.structured();
    }

    this.available = input.tools?.map((tool) => tool.function.name) ?? [];
    this.rounds += 1;

    if (this.rounds !== 1) return this.laterRound();
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
  private laterRound(): Response {
    if (this.mode === "/unavailable-after-query") {
      return Response.json(
        { error: { code: "insufficient_quota", message: "fixture" } },
        { status: 429 }
      );
    }

    if (
      this.mode === "/malformed" ||
      this.mode === "/invalid-after-query" ||
      (this.mode === "/repair-after-query" && this.rounds === 2)
    ) {
      return Response.json({
        choices: [
          { message: { role: "assistant", content: { invalid: true } }, finish_reason: "stop" },
        ],
      });
    }

    return completion("Listo.");
  }
  private browserRequest(request: Request): Option.Option<Promise<Response>> {
    if (request.url === "https://fixture.invalid/disconnect-browser") {
      this.browserClient.abort();

      return Option.some(Promise.resolve(new Response(null, { status: 204 })));
    }

    if (
      request.url === "https://fixture.invalid/browser-admission" ||
      request.url === "https://fixture.invalid/browser-progress"
    ) {
      const path = request.url.endsWith("admission") ? "" : "/progress";

      return Option.some(
        Effect.runPromise(
          Effect.tryPromise({
            try: () =>
              request.text().then((body) =>
                this.env.INGRESS.fetch("https://api.fidyapp.com/web/hosted-turns" + path, {
                  method: "POST",
                  headers: {
                    origin: "https://app.fidyapp.com",
                    cookie: "__Host-fidy_session=" + "1".repeat(browserBearerLength),
                    "Fidy-Session-Binding": "10000000-0000-4000-8000-000000000061",
                    "content-type": "application/json",
                  },
                  body,
                  signal: this.browserClient.signal,
                })
              ),
            catch: (cause) =>
              this.browserClient.signal.aborted
                ? new BrowserRequestAborted({ cause })
                : new BrowserRequestFailed({ cause }),
          }).pipe(
            Effect.catchTag("BrowserRequestAborted", (failure) =>
              Effect.logWarning({
                component: "hosted-provider-fixture",
                outcome: "browser_aborted",
                cause: failure.cause,
              }).pipe(Effect.as(new Response(null, { status: 499 })))
            )
          )
        )
      );
    }

    return Option.none();
  }
  private readonly templateSend = Effect.fn({ self: this }, function* (request: Request) {
    const body = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        biz_opaque_callback_data: Schema.String,
        template: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
      })
    )(yield* Effect.tryPromise(() => request.json()));

    if (body.template !== undefined) this.templates.push(body.template.name);
    this.sends += 1;
    this.correlation = body.biz_opaque_callback_data;

    return new Response(null, { status: 503 });
  });
  override fetch(request: Request): Promise<Response> {
    if (request.url === "https://fixture.invalid/templates") {
      return Promise.resolve(Response.json(this.templates));
    }

    if (request.url === "https://fixture.invalid/compaction") {
      return Effect.runPromise(this.configureCompaction(request));
    }

    const browser = this.browserRequest(request);

    if (Option.isSome(browser)) return browser.value;

    if (new URL(request.url).pathname === "/tools") {
      if (request.method !== "POST") return Promise.resolve(Response.json(this.available));

      return Effect.runPromise(
        Effect.gen({ self: this }, function* () {
          this.requested = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ name: Schema.String, arguments: Schema.String }))
          )(yield* Effect.tryPromise(() => request.json()));
          this.rounds = 0;

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

        if (textModes.includes(path)) {
          this.mode = path;

          return new Response(null, { status: 204 });
        }

        if (path === "/sends") {
          return Response.json({ sends: this.sends, correlation: this.correlation });
        }

        if (new URL(request.url).hostname === "api.kapso.ai") {
          return yield* this.templateSend(request);
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
