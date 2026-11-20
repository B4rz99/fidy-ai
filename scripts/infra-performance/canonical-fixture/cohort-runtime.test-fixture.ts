import { Database } from "bun:sqlite";
import { Config, DateTime, Effect, Option, Redacted, Schema } from "effect";
import type { Miniflare } from "miniflare";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import { establishSmokeUsers } from "../../../infra/cloudflare/native-acceptance";
import { native } from "../../../apps/server/cloudflare/user-store.test-fixture";
import { transport } from "./bridge";
import { closedRuntime } from "./closed-runtime.test-fixture";
import { type CohortCommand, cohortAuthority, serveCohort } from "./cohort-bridge";

const readObject = Effect.fnUntraced(function* (runtime: Miniflare, directory: string, id: string) {
  if (!/^[a-f0-9]{64}$/u.test(id)) return yield* Effect.fail(Error("Unknown physical object"));
  // Close the workerd writer before inspecting its SQLite files during a physical census.
  yield* native(async () => {
    try {
      await runtime.unsafeEvictDurableObject("core", "UserStore", { id });
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          error.message === "Cannot evict Durable Object: it is not currently running."
        )
      )
        {throw error;}
    }
  });
  const files = yield* native(() =>
    Array.fromAsync(new Bun.Glob("**/" + id + ".sqlite").scan({ cwd: directory, absolute: true }))
  );
  if (files.length !== 1 || files[0] === undefined) {
    return yield* Effect.fail(Error("Physical inventory unavailable"));
  }
  const db = new Database(files[0], { readonly: true });
  try {
    return [
      id,
      db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='users'").get() !== null,
    ] as const;
  } finally {
    db.close();
  }
});
const state = Effect.fnUntraced(function* (runtime: Miniflare, directory: string) {
  const ids = yield* native(() => runtime.listDurableObjectIds("UserStore", "core"));
  return Object.fromEntries(yield* Effect.forEach(ids, (id) => readObject(runtime, directory, id)));
});
const marker = Effect.fnUntraced(function* (runtime: Miniflare, revision: string) {
  const bucket = yield* native(() => runtime.getR2Bucket("SMOKE_BUCKET", "core"));
  const value = yield* native(() =>
    bucket.get("_release-smoke/" + revision + "/acceptance/transactions/performance-1")
  );
  return value === null ? null : yield* native(() => value.text());
});
const recoveryProbe = Effect.fnUntraced(function* (runtime: Miniflare, secret: string) {
  const response = yield* transport(runtime)(
    new Request(installedOrigins.acceptance.api + "/internal/release-smoke?storage=compatibility", {
      headers: { "x-fidy-smoke-proof": secret },
    })
  );
  const evidence = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      core: Schema.Struct({ workerVersionId: Schema.String }),
      fixtureFallbackCoreVersion: Schema.optional(Schema.String),
    })
  )(yield* native(() => response.json()));
  return {
    status: response.status,
    ingress: response.headers.get("x-fidy-fixture-fallback-ingress") !== null,
    core: evidence.fixtureFallbackCoreVersion === evidence.core.workerVersionId,
  };
});
const tick = Effect.fnUntraced(function* (runtime: Miniflare) {
  const core = yield* native(() => runtime.getWorker("core"));
  const now = DateTime.toDateUtc(yield* DateTime.now);
  return (
    (yield* native(() => core.scheduled({ cron: "* * * * *", scheduledTime: now }))).outcome ===
    "ok"
  );
});
const requestSchema = Schema.Struct({
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  method: Schema.Literals(["POST", "GET"]),
  body: Schema.NullOr(Schema.String),
});
const dispatch = Effect.fnUntraced(function* (runtime: Miniflare, value: unknown) {
  const req = yield* Schema.decodeUnknownEffect(requestSchema)(value);
  if (new URL(req.url).origin !== installedOrigins.acceptance.api) {
    return yield* Effect.fail(Error("Foreign rehearsal origin"));
  }
  const response = yield* transport(runtime)(
    new Request(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body === null ? {} : { body: req.body }),
    })
  );
  return {
    status: response.status,
    headers: [...response.headers],
    body: yield* native(() => response.text()),
  };
});
const run = Effect.gen(function* () {
  const auth = yield* cohortAuthority;
  const directory = yield* Config.String("FIDY_REHEARSAL_STATE");
  yield* Effect.acquireUseRelease(
    closedRuntime(auth, directory),
    (runtime) => {
      const send = transport(runtime);
      const local = Effect.fnUntraced(function* (item: CohortCommand) {
        const action = item.action;
        if (action === "provider-request") return yield* dispatch(runtime, item.body);
        if (["seed-survivors", "mount-original-sessions"].includes(action)) {
          const users = yield* establishSmokeUsers({
            revision: auth.revision,
            proof: Redacted.make(auth.secret),
            origins: installedOrigins.acceptance,
            send,
            erasure: Option.none(),
          });
          return action === "mount-original-sessions" ? [users[0].headers, users[1].headers] : true;
        }
        if (action === "recovery-probe") return yield* recoveryProbe(runtime, auth.secret);
        if (action === "census") return yield* state(runtime, directory);
        if (action === "marker") return yield* marker(runtime, auth.revision);
        if (action === "tick") return yield* tick(runtime);
        return yield* Effect.fail(Error("Unknown rehearsal operation"));
      });
      return serveCohort(auth, () => send, local);
    },
    (runtime) => native(() => runtime.dispose())
  );
});
await Effect.runPromise(run);
