import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import type { RecoveryAdmissionBinding } from "../recovery-activation/contract";
import { runRecoveryFetch, withRecoveryBucket, withRecoveryDatabase } from "./runtime";

export { RecoveryAdmissionGate } from "../recovery-activation/runtime";

type Bindings = Readonly<{
  DB: D1Database;
  BUCKET: R2Bucket;
  RECOVERY_SOURCE_EPOCH: string;
  RECOVERY_ADMISSION: { getByName(name: string): RecoveryAdmissionBinding };
}>;

/** A resident owner deliberately shares its Effect scheduler across concurrent native requests. */
export class ConcurrentOwner extends DurableObject<Bindings> {
  private readonly services = ManagedRuntime.make(Layer.empty);
  private readonly release = Promise.withResolvers<void>();
  private readonly late = Promise.withResolvers<void>();
  private readonly lateResult = Promise.withResolvers<string>();
  private readonly entered = Promise.withResolvers<void>();
  private readonly outcome = Promise.withResolvers<number>();
  private readonly db = withRecoveryDatabase({ binding: this.env.DB, environment: this.env });
  private readonly bucket = withRecoveryBucket({ binding: this.env.BUCKET, environment: this.env });

  private hold(): Promise<Response> {
    const body = new FixedLengthStream(1);
    const writer = body.writable.getWriter();
    this.ctx.waitUntil(
      this.release.promise.then(() => writer.write(new Uint8Array([1]))).then(() => writer.close())
    );
    return runRecoveryFetch({
      environment: this.env,
      context: Option.none(),
      work: () =>
        this.services.runPromise(
          Effect.gen({ self: this }, function* () {
            yield* Effect.yieldNow;
            yield* Effect.tryPromise(() => this.db.prepare("SELECT 1 AS value").first());
            yield* Effect.tryPromise(() => {
              const native = this.bucket.put("held-A", body.readable);
              this.entered.resolve();
              return native;
            }).pipe(
              Effect.timeout("20 millis"),
              Effect.catch(() => Effect.void)
            );
            return new Response("private A");
          })
        ),
    });
  }

  private other(): Promise<Response> {
    return runRecoveryFetch({
      environment: this.env,
      context: Option.none(),
      work: () =>
        Effect.runPromise(
          Effect.gen({ self: this }, function* () {
            yield* Effect.yieldNow;
            yield* Effect.tryPromise(() => this.db.prepare("SELECT 2 AS value").first());
            yield* Effect.tryPromise(() => this.bucket.put("completed-B", "B"));
            this.late.promise
              .then(() => this.bucket.put("late-B", "forbidden"))
              .then(
                () => this.lateResult.resolve("escaped"),
                () => this.lateResult.resolve("denied")
              );
            return new Response("private B");
          })
        ),
    });
  }

  fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/start") {
      this.ctx.waitUntil(
        this.hold().then((response) => {
          this.entered.resolve();
          this.outcome.resolve(response.status);
        })
      );
      return this.entered.promise.then(() => new Response("started"));
    }
    if (path === "/other") return this.other();
    if (path === "/late") {
      this.late.resolve();
      return this.lateResult.promise.then((value) => new Response(value));
    }
    if (path === "/release") {
      this.release.resolve();
      return this.outcome.promise.then((status) => Response.json({ status }));
    }
    return this.env.BUCKET.head("late-B").then((value) =>
      Response.json({ lateWritten: value !== null })
    );
  }
}

export default {
  fetch(
    request: Request,
    env: Readonly<{
      OWNER: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
      RECOVERY_ADMISSION: Bindings["RECOVERY_ADMISSION"];
    }>
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    const gate = env.RECOVERY_ADMISSION.getByName("source-admission-v1");
    if (path === "/inspect") return gate.inspect().then(Response.json);
    if (path === "/close") {
      return gate.close({ epoch: "source-epoch", activationId: "cutover" }).then(Response.json);
    }
    return env.OWNER.getByName("resident-owner").fetch(request);
  },
};
