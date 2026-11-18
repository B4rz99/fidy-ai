import { Effect, Option, Schedule } from "effect";
import {
  Directory as NativeDirectory,
  Erasure as NativeErasure,
  UserStore as NativeUser,
} from "./core-worker";

export { default } from "./core-worker";
export * from "./core-worker";

type UserEnvironment = ConstructorParameters<typeof NativeUser>[1];
const marker = "private-fixture";

/** Delay the actual bound R2 create after its production User writer commits. */
const heldBucket = (bucket: R2Bucket, storage: DurableObjectStorage): R2Bucket =>
  new Proxy(bucket, {
    get(target, property) {
      if (property === "put") {
        return (...args: Parameters<R2Bucket["put"]>) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const released = yield* Effect.tryPromise(() =>
                storage.get<boolean>(
                  args[0].startsWith("samples/") ? "hold-sample" : "fixture-hold"
                )
              ).pipe(
                Effect.repeat({
                  while: (value) => value === true,
                  schedule: Schedule.spaced("20 millis"),
                }),
                Effect.timeoutOption("30 seconds")
              );
              if (Option.isNone(released)) return yield* Effect.die("Fixture release timed out");
              return yield* Effect.tryPromise(() => target.put(...args));
            })
          );
      }
      const value: unknown = Reflect.get(target, property);
      const bound: unknown = typeof value === "function" ? value.bind(target) : value;
      return bound;
    },
  });

/** Fixture-only inspection reads the native KV and alarm even when SQL has been deallocated. */
export class UserStore extends NativeUser {
  constructor(state: DurableObjectState, env: UserEnvironment) {
    super(state, {
      ...env,
      EMAIL_BUCKET: heldBucket(env.EMAIL_BUCKET, state.storage),
      SAMPLE_BUCKET: heldBucket(env.SAMPLE_BUCKET, state.storage),
    });
  }
  override fetch(request: Request): Promise<Response> {
    const store = this.ctx.storage;
    switch (request.url) {
      case "https://fixture.invalid/hold-sample":
        return store.put("hold-sample", true).then(() => new Response(null, { status: 204 }));
      case "https://fixture.invalid/release-sample":
        return store.delete("hold-sample").then(() => new Response(null, { status: 204 }));
      case "https://fixture.invalid/hold-original":
        return store
          .put({ "fixture-hold": true, [marker]: "synthetic private value" })
          .then(() => new Response(null, { status: 204 }));
      case "https://fixture.invalid/release-original":
        return store.delete("fixture-hold").then(() => new Response(null, { status: 204 }));
      case "https://fixture.invalid/storage":
        return Promise.all([store.list({ limit: 4 }), store.getAlarm()]).then(([keys, alarm]) =>
          Response.json({ keys: keys.size, alarm })
        );
      default:
        return super.fetch(request);
    }
  }
}

/** The fixture invokes the production case alarm/commands at a chosen instant in its own test isolate. */
export class Erasure extends NativeErasure {
  override fetch(request: Request): Promise<Response> {
    const instant = request.headers.get("fixture-erasure-clock");
    if (instant === null) return super.fetch(request);
    const original = Date.now;
    Date.now = (): number => Number(instant);
    return (
      request.url === "https://fixture.invalid/case-alarm"
        ? super.alarm().then(() => new Response(null, { status: 204 }))
        : super.fetch(request)
    ).finally(() => {
      Date.now = original;
    });
  }
}

export class Directory extends NativeDirectory {
  override fetch(request: Request): Promise<Response> {
    const instant = request.headers.get("fixture-erasure-clock");
    if (instant === null) return super.fetch(request);
    const original = Date.now;
    Date.now = (): number => Number(instant);
    return super.fetch(request).finally(() => {
      Date.now = original;
    });
  }
}
