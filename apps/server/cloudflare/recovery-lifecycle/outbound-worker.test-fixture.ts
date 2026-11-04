import { DurableObject } from "cloudflare:workers";
import { Context, Effect, Layer, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { OutboundHttpLive } from "../outbound-http/runtime";
import type { RecoveryAdmissionBinding } from "../recovery-activation/contract";
import { runRecoveryFetch } from "./runtime";

export { RecoveryAdmissionGate } from "../recovery-activation/runtime";

export class HeldProvider extends DurableObject {
  private readonly release = Promise.withResolvers<void>();
  fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/release") {
      this.release.resolve();
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return this.release.promise.then(() => new Response("provider accepted"));
  }
}
type Environment = Readonly<{
  RECOVERY_SOURCE_EPOCH: string;
  RECOVERY_ADMISSION: { getByName(name: string): RecoveryAdmissionBinding };
  PROVIDER: { getByName(name: string): Pick<Fetcher, "fetch"> };
}>;
export class HttpOwner extends DurableObject<Environment> {
  private readonly entered = Promise.withResolvers<void>();
  private readonly timedOut = Promise.withResolvers<void>();
  private readonly result = Promise.withResolvers<number>();
  private readonly cancelRelease = Promise.withResolvers<void>();
  private execute(cancelBody: boolean): Promise<Response> {
    const native: typeof fetch = Object.assign(
      (): Promise<Response> => {
        this.entered.resolve();
        if (cancelBody) {
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull: (): Promise<void> => Promise.withResolvers<void>().promise,
                  cancel: (): Promise<void> => this.cancelRelease.promise,
                },
                { highWaterMark: 0 }
              )
            )
          );
        }
        // Native service deliberately does not accept AbortSignal: the operation is still alive.
        return this.env.PROVIDER.getByName("provider").fetch(new Request("https://provider/held"));
      },
      { preconnect: (): void => undefined }
    );
    return runRecoveryFetch({
      environment: this.env,
      context: Option.none(),
      work: () =>
        Effect.runPromise(
          Effect.gen({ self: this }, function* () {
            const clients = yield* Layer.build(OutboundHttpLive);
            const client = Context.get(clients, HttpClient.HttpClient);
            yield* client.get("https://provider/held").pipe(
              Effect.flatMap((response) => response.text),
              Effect.timeout("20 millis"),
              Effect.catch(() => Effect.sync(() => this.timedOut.resolve()))
            );
            return new Response("private result");
          }).pipe(Effect.provideService(FetchHttpClient.Fetch, native), Effect.scoped)
        ),
    });
  }
  fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/cancel-reject") {
      this.cancelRelease.reject(new Error("Provider cancellation unacknowledged"));
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === "/cancel-release") {
      this.cancelRelease.resolve();
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === "/start" || path === "/start-cancel") {
      this.ctx.waitUntil(
        this.execute(path === "/start-cancel").then((response) =>
          this.result.resolve(response.status)
        )
      );
      return this.entered.promise
        .then(() => this.timedOut.promise)
        .then(() => new Response("timed out locally"));
    }
    return this.result.promise.then((status) => Response.json({ status }));
  }
}
export default {
  fetch(
    request: Request,
    env: Environment & Readonly<{ OWNER: { getByName(name: string): Pick<Fetcher, "fetch"> } }>
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    const gate = env.RECOVERY_ADMISSION.getByName("source-admission-v1");
    if (path === "/inspect") return gate.inspect().then(Response.json);
    if (path === "/close") {
      return gate.close({ epoch: "source-epoch", activationId: "cutover" }).then(Response.json);
    }
    if (path === "/release") {
      return env.PROVIDER.getByName("provider").fetch(new Request("https://provider/release"));
    }
    return env.OWNER.getByName("owner").fetch(request);
  },
};
