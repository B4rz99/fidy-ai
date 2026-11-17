import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect } from "effect";

type Environment = Readonly<{ PROVIDER_STATE: D1Database }>;

/** Local outbound Worker only. Accept a void and lose its response, then expose the independent provider state. */
export class CancellationProviderFixture extends WorkerEntrypoint<Environment> {
  override fetch(request: Request): Promise<Response> {
    const env = this.env;
    return Effect.runPromise(
      Effect.gen(function* () {
        const path = new URL(request.url).pathname;
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
