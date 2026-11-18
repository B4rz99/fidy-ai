import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schedule } from "effect";

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
