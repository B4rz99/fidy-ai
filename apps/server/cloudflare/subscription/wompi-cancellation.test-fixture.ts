import { WorkerEntrypoint } from "cloudflare:workers";
import { Clock, DateTime, Effect, Schedule } from "effect";
import { Hex } from "effect/encoding";

type Environment = Readonly<{ PROVIDER_STATE: D1Database }>;

const chargeFixture = Effect.fn(function* (request: Request, env: Environment, path: string) {
  if (request.method === "POST" && path === "/v1/transactions") {
    yield* Effect.tryPromise(() =>
      env.PROVIDER_STATE.prepare("INSERT INTO charge_posts DEFAULT VALUES").run()
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
/** Local outbound Worker only. Accept a void and lose its response, then expose the independent provider state. */
export class CancellationProviderFixture extends WorkerEntrypoint<Environment> {
  override fetch(request: Request): Promise<Response> {
    const env = this.env;
    return Effect.runPromise(
      Effect.gen(function* () {
        if (new URL(request.url).hostname === "api.kapso.ai") {
          return yield* Effect.tryPromise(() => statementProvider(request));
        }
        const path = new URL(request.url).pathname;
        if (path.startsWith("/v1/transactions")) return yield* chargeFixture(request, env, path);
        if (request.method === "PUT" && path === "/v1/payment_sources/78001/void") {
          yield* Effect.tryPromise(() =>
            env.PROVIDER_STATE.prepare("INSERT INTO received_voids(source) VALUES (78001)").run()
          );
          return new Response(null, { status: 503 });
        }
        if (request.method === "GET" && path === "/v1/payment_sources/78001") {
          const present = yield* Effect.tryPromise(() =>
            env.PROVIDER_STATE.prepare(
              "SELECT 1 FROM received_voids WHERE source=78001 LIMIT 1"
            ).first()
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
      })
    );
  }
}

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
const statementProvider = (request: Request): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const url = new URL(request.url);
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
