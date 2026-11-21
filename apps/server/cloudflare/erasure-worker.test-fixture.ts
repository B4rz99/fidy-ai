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

const heldPut =
  (bucket: R2Bucket, storage: DurableObjectStorage): R2Bucket["put"] =>
  (...args) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const released = yield* Effect.tryPromise(() =>
          storage.get<boolean>(args[0].startsWith("samples/") ? "hold-sample" : "fixture-hold")
        ).pipe(
          Effect.repeat({
            while: (value) => value === true,
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeoutOption("30 seconds")
        );

        if (Option.isNone(released)) return yield* Effect.die("Fixture release timed out");

        return yield* Effect.tryPromise(() => bucket.put(...args));
      })
    );

const heldBucket = (bucket: R2Bucket, storage: DurableObjectStorage): R2Bucket => ({
  head: bucket.head.bind(bucket),
  get: bucket.get.bind(bucket),
  put: heldPut(bucket, storage),
  createMultipartUpload: bucket.createMultipartUpload.bind(bucket),
  resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
  delete: bucket.delete.bind(bucket),
  list: bucket.list.bind(bucket),
});

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
      case "https://fixture.invalid/user-alarm": {
        const original = Date.now;
        const instant = request.headers.get("fixture-clock");

        if (instant !== null) Date.now = (): number => Number(instant);

        return super
          .alarm()
          .then(
            () => new Response(null, { status: 204 }),
            () => new Response(null, { status: 503 })
          )
          .finally(() => {
            Date.now = original;
          });
      }

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

    return (
      request.url === "https://fixture.invalid/directory-alarm"
        ? super.alarm().then(() => new Response(null, { status: 204 }))
        : super.fetch(request)
    ).finally(() => {
      Date.now = original;
    });
  }
}
