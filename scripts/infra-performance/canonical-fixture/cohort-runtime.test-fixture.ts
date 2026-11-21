import type { PerformanceMember } from "../../../apps/server/cloudflare/release-isolation/contract";
import { Database } from "bun:sqlite";
import {
  Config,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import type { Miniflare } from "miniflare";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import { FetchHttpClient, HttpClient } from "effect/http";
import { acceptanceSend } from "../../../infra/cloudflare/native-storage-release";
import { ReleaseHttpLive } from "../../../infra/cloudflare/release-http";
import {
  establishSmokeUsers,
  retainedFinancialControls,
} from "../../../infra/cloudflare/native-acceptance";
import { native } from "../../../apps/server/cloudflare/user-store.test-fixture";
import { transport } from "./bridge";
import { closedRuntime } from "./closed-runtime.test-fixture";
import { type CohortCommand, cohortAuthority, serveCohort } from "./cohort-bridge";

const isRequest = Schema.is(Schema.instanceOf(Request));

const readObject = Effect.fnUntraced(function* (runtime: Miniflare, directory: string, id: string) {
  if (!/^[a-f0-9]{64}$/u.test(id)) return yield* Effect.fail(Error("Unknown physical object"));
  yield* native(() =>
    runtime.unsafeEvictDurableObject("core", "UserStore", { id }).catch((error: unknown) => {
      if (
        Predicate.isError(error) &&
        error.message === "Cannot evict Durable Object: it is not currently running."
      ) {
        return;
      }

      throw error;
    })
  );

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

const marker = Effect.fnUntraced(function* (
  runtime: Miniflare,
  revision: string,
  member: PerformanceMember
) {
  const bucket = yield* native(() => runtime.getR2Bucket("SMOKE_BUCKET", "core"));

  const value = yield* native(() =>
    bucket.get("_release-smoke/" + revision + "/acceptance/transactions/" + member)
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

  const init: RequestInit = { method: req.method, headers: req.headers };

  if (req.body !== null) init.body = req.body;

  const response = yield* transport(runtime)(new Request(req.url, init));

  return {
    status: response.status,
    headers: [...response.headers],
    body: yield* native(() => response.text()),
  };
});

const financialControls = Effect.fnUntraced(function* (
  runtime: Miniflare,
  auth: { revision: string; secret: string },
  streamed: boolean
) {
  const listener = yield* native(() => runtime.ready);
  const client = Context.get(yield* Layer.build(ReleaseHttpLive), HttpClient.HttpClient);
  const network = yield* FetchHttpClient.Fetch;

  const loopback: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const url = new URL(isRequest(input) ? input.url : input);

      if (url.origin !== installedOrigins.acceptance.api) {
        return Promise.reject(Error("Foreign rehearsal origin"));
      }

      const headers = new Headers(init?.headers);
      headers.set("cf-connecting-ip", "192.0.2.1");

      return network(new URL(url.pathname + url.search, listener), { ...init, headers });
    },
    { preconnect: network.preconnect }
  );

  return yield* retainedFinancialControls({
    revision: auth.revision,
    proof: Redacted.make(auth.secret),
    origins: installedOrigins.acceptance,
    send: streamed ? acceptanceSend(client) : transport(runtime),
  }).pipe(Effect.provideService(FetchHttpClient.Fetch, loopback));
}, Effect.scoped);

const run = Effect.gen(function* () {
  const auth = yield* cohortAuthority;
  const directory = yield* Config.String("FIDY_REHEARSAL_STATE");
  yield* Effect.acquireUseRelease(
    closedRuntime(auth, directory, auth.member),
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

        if (action === "marker") return yield* marker(runtime, auth.revision, auth.member);

        if (action === "tick") return yield* tick(runtime);

        return yield* Effect.fail(Error("Unknown rehearsal operation"));
      });

      return serveCohort(
        auth,
        () => send,
        (item) =>
          ["controls", "streamed-controls"].includes(item.action)
            ? financialControls(runtime, auth, item.action === "streamed-controls")
            : local(item)
      );
    },
    (runtime) => native(() => runtime.dispose())
  );
});

await Effect.runPromise(run);
