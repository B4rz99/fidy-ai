import { WorkerEntrypoint } from "cloudflare:workers";
import { Clock, DateTime, Effect, Schedule, Schema } from "effect";
import { Hex } from "effect/encoding";

type Environment = Readonly<{ PROVIDER_STATE: D1Database }>;

const chargeFixture = Effect.fn(function* (request: Request, env: Environment, path: string) {
  if (request.method === "POST" && path === "/v1/transactions") {
    const charge = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        amount_in_cents: Schema.Int,
        currency: Schema.String,
        reference: Schema.String,
        payment_source_id: Schema.Int,
      })
    )(yield* Effect.tryPromise(() => request.json()));
    yield* Effect.tryPromise(() =>
      env.PROVIDER_STATE.prepare(
        "INSERT INTO charge_posts(reference,amount,currency,source) VALUES(?,?,?,?)"
      )
        .bind(charge.reference, charge.amount_in_cents, charge.currency, charge.payment_source_id)
        .run()
    );
    const released = Effect.tryPromise(() =>
      env.PROVIDER_STATE.prepare("SELECT released FROM charge_control").first()
    ).pipe(
      Effect.flatMap((row) => (row?.released === 1 ? Effect.void : Effect.fail("waiting" as const)))
    );
    yield* released.pipe(Effect.retry({ times: 180, schedule: Schedule.spaced("50 millis") }));
    return new Response(null, { status: 503 });
  }
  if (request.method === "GET" && path === "/v1/transactions/provider-callback-id") {
    const row = yield* Effect.tryPromise(() =>
      env.PROVIDER_STATE.prepare("SELECT reference,amount,source FROM charge_control").first()
    );
    if (row === null) return new Response(null, { status: 404 });
    return Response.json({
      data: {
        id: "provider-callback-id",
        reference: row.reference,
        amount_in_cents: row.amount,
        payment_source_id: row.source,
        currency: "COP",
        status: "APPROVED",
        finalized_at: "2026-11-17T10:00:00.000Z",
      },
    });
  }
  return new Response(null, { status: 404 });
});
const hashLength = 64;
const syntheticSources = { NEQUI: 5102, CARD: 5101 } as const;
const isEnrollmentPath = (path: string): boolean =>
  path.startsWith("/v1/merchants/") ||
  path.startsWith("/v1/tokens/") ||
  ["/v1/payment_sources", "/v1/payment_sources/5101", "/v1/payment_sources/5102"].includes(path);
const createSource = Effect.fn(function* (request: Request, env: Environment) {
  const charge = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ type: Schema.Literals(["NEQUI", "CARD"]), token: Schema.String })
  )(yield* Effect.tryPromise(() => request.json()));
  if (charge.token === "tok_test_held_source") {
    const db = env.PROVIDER_STATE;
    yield* Effect.tryPromise(() => db.prepare("UPDATE held_source SET issued=issued+1").run());
    yield* Effect.tryPromise(() =>
      db.prepare("SELECT released FROM held_source").first<number>("released")
    ).pipe(
      Effect.repeat({
        while: (released) => released === 0,
        schedule: Schedule.spaced("30 millis"),
      }),
      Effect.timeout("12 seconds")
    );
    return Response.json({ data: { id: syntheticSources[charge.type], status: "DECLINED" } });
  }
  return Response.json({
    data: { id: syntheticSources[charge.type], status: "AVAILABLE" },
  });
});
const enrollmentProvider = Effect.fn(function* (request: Request, path: string, env: Environment) {
  if (path.startsWith("/v1/tokens/nequi/")) {
    return Response.json({
      data: {
        id: path.split("/").at(-1),
        status: path.endsWith("_approved") ? "APPROVED" : "PENDING",
      },
    });
  }
  if (path === "/v1/payment_sources/5102") {
    return Response.json({
      data: { id: 5102, type: "NEQUI", status: "AVAILABLE", customer_email: "payer@example.com" },
    });
  }
  if (path.startsWith("/v1/merchants/")) {
    const accepted = (name: string): { permalink: string; acceptance_token: string } => {
      const permalink = "https://wompi.example/" + name + ".pdf";
      return {
        permalink,
        acceptance_token:
          "header." +
          btoa(JSON.stringify({ permalink, file_hash: "a".repeat(hashLength) }))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/u, "") +
          ".signature",
      };
    };
    return Response.json({
      data: {
        presigned_acceptance: accepted("terms"),
        presigned_personal_data_auth: accepted("personal"),
      },
    });
  }
  if (path === "/v1/payment_sources" && request.method === "POST") {
    return yield* createSource(request, env);
  }
  if (path === "/v1/payment_sources/5101") {
    return Response.json({
      data: {
        id: 5101,
        status: "AVAILABLE",
        type: "CARD",
        customer_email: "payer@example.com",
      },
    });
  }
  return new Response(null, { status: 404 });
});
/** Local outbound Worker only. Accept a void and lose its response, then expose the independent provider state. */
const refundFixture = Effect.fnUntraced(function* (request: Request, env: Environment) {
  const material = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      transaction_id: Schema.String,
      amount_in_cents: Schema.Int,
      reference: Schema.String,
    })
  )(yield* Effect.tryPromise(() => request.json()));
  yield* Effect.tryPromise(() =>
    env.PROVIDER_STATE.prepare("INSERT INTO refund_requests(reference,amount) VALUES(?,?)")
      .bind(material.reference, material.amount_in_cents)
      .run()
  );
  return Response.json(
    { data: { ...material, id: 91, v2_refund_id: "verified-sandbox-refund", status: "APPROVED" } },
    { status: 201 }
  );
});
const cancellationResponse = Effect.fnUntraced(function* (
  request: Request,
  env: Environment,
  path: string
) {
  const command = request.method + " " + path;
  if (command === "PUT /v1/payment_sources/78001/void") {
    yield* Effect.tryPromise(() =>
      env.PROVIDER_STATE.prepare("INSERT INTO received_voids(source) VALUES (78001)").run()
    );
    return new Response(null, { status: 503 });
  }
  if (command === "GET /v1/payment_sources/78001") {
    const present = yield* Effect.tryPromise(() =>
      env.PROVIDER_STATE.prepare("SELECT 1 FROM received_voids WHERE source=78001 LIMIT 1").first()
    );
    return Response.json({
      data: {
        id: 78001,
        type: "DAVIPLATA",
        status: present === null ? "AVAILABLE" : "VOIDED",
      },
    });
  }
  return new Response(null, { status: 404 });
});
export class CancellationProviderFixture extends WorkerEntrypoint<Environment> {
  override fetch(request: Request): Promise<Response> {
    const env = this.env;
    return Effect.runPromise(
      Effect.gen(function* () {
        if (request.url === "https://api.openai.com/v1/chat/completions") {
          return yield* statementModel(request);
        }
        if (new URL(request.url).hostname === "api.kapso.ai") {
          return yield* Effect.tryPromise(() => statementProvider(request));
        }
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === "/v1/refunds") {
          return yield* refundFixture(request, env);
        }
        if (isEnrollmentPath(path)) {
          return yield* enrollmentProvider(request, path, env);
        }
        if (path.startsWith("/v1/transactions")) return yield* chargeFixture(request, env, path);
        return yield* cancellationResponse(request, env, path);
      })
    );
  }
}

const statementModel = Effect.fnUntraced(function* (request: Request) {
  const input = yield* Effect.tryPromise(() => request.text());
  const item = /fila-prueba ([0-9a-f-]{36})/u.exec(input)?.[1];
  if (item === undefined) return new Response(null, { status: 400 });
  const batched = input.includes("lote fila-prueba");
  const args = batched
    ? {
        payload: {
          calls: [
            {
              callId: "22460000-0000-4000-8000-000000000011",
              operation: "ingestion.skipNeedsReviewItem",
              input: { params: { id: item } },
            },
            {
              callId: "22460000-0000-4000-8000-000000000012",
              operation: "dashboard.initializeDashboard",
              input: {},
            },
          ],
        },
      }
    : { params: { id: item } };
  return Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "skip-review",
              type: "function",
              function: {
                name: batched ? "operations__executeAtomicBatch" : "ingestion__skipNeedsReviewItem",
                arguments: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(args),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
});
const signedMediaLifetimeMs = 60_000;
const media = "media_statement_123";
const mixed = "media_statement_mixed";
const mixedBytes = new TextEncoder().encode(
  "fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n2026-08-02,uncertain,COP,Tienda\n"
);
const defaultBytes = new TextEncoder().encode("encabezado,valor\nprimero,20\nsegundo,50\n");
const mediaVariants = new Map([
  [media, defaultBytes],
  [mixed, mixedBytes],
  ["media_statement_pdf", new TextEncoder().encode("%PDF-1.7")],
]);
const voiceFixture = Effect.fn(function* (request: Request) {
  if (new URL(request.url).pathname.endsWith("/123456789012345/messages")) {
    const payload = yield* Effect.tryPromise(() => request.json());
    if (
      Schema.is(
        Schema.Struct({
          text: Schema.Struct({
            body: Schema.Literal("No pude procesar la nota de voz. Envíala de nuevo o escríbeme."),
          }),
        })
      )(payload)
    ) {
      return Response.json({
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.voice-fixture" }],
      });
    }
  }
  return new Response(null, { status: 503 });
});
const statementProvider = (request: Request): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const url = new URL(request.url);
      if (request.method === "POST") return yield* voiceFixture(request);
      const id = url.searchParams.get("token") ?? url.pathname.split("/").at(-1) ?? "";
      const bytes = mediaVariants.get(id);
      if (bytes === undefined) return new Response(null, { status: 404 });
      if (url.pathname.endsWith("/" + id)) {
        return Response.json({
          id,
          mime_type: "text/csv",
          file_size: bytes.length,
          sha256: Hex.encode(
            new Uint8Array(yield* Effect.tryPromise(() => crypto.subtle.digest("SHA-256", bytes)))
          ),
          download_url: "https://api.kapso.ai/meta/whatsapp/media_download?token=" + id,
          download_url_expires_at: DateTime.formatIso(
            DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + signedMediaLifetimeMs)
          ),
        });
      }
      if (
        url.pathname === "/meta/whatsapp/media_download" &&
        url.searchParams.get("token") === id
      ) {
        return new Response(bytes);
      }
      return new Response(null, { status: 404 });
    })
  );
