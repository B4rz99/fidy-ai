import { ownerCheckUrl } from "../apps/server/cloudflare/maintenance/contract";
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import { Clock, Context, Effect, Layer } from "effect";
import type { Miniflare } from "miniflare";
import { browserOrigins } from "../apps/server/cloudflare/runtime/contract";
import { storeReadinessUrl } from "../apps/server/cloudflare/runtime/sqlite/contract";
import { signedChat } from "../apps/server/cloudflare/signed-whatsapp.test-fixture";
import { native, nativeBrowserPlatform } from "../apps/server/cloudflare/user-store.test-fixture";

const secondMs = 1000;

const trialLengthMs = 604800000;

const noContent = 204;

const caller = "CO.Recurring";

const recurringUser = "24000000-0000-4000-8000-000000000401";

const origin = "https://127.0.0.1:4174";

const operator = "http://127.0.0.1:4175";

export const prepareBrowserUser = Effect.fn(function* (runtime: Miniflare, subject: string) {
  const user = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
  const directory = yield* native(() => runtime.getDurableObjectNamespace("DIRECTORY", "core"));
  const ready = yield* native(() => directory.getByName("directory-v1").fetch(storeReadinessUrl));

  if (!ready.ok) return yield* Effect.die("Native directory is unavailable");
  yield* native(() => user.getByName(subject).fetch(ownerCheckUrl, { method: "POST" }));

  const owner = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: subject })
  );

  const routes = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  const now = yield* Clock.currentTimeMillis;
  yield* native(() =>
    owner.exec(
      "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,trial_started_at_ms,trial_ends_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?,?,?,'portfolio',?,?)",
      subject,
      now,
      now,
      now + trialLengthMs,
      caller,
      now - secondMs
    )
  );
  yield* native(() =>
    owner.exec(
      "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('fixture-grant',?,'processing_grant',?)",
      subject,
      now
    )
  );
  yield* native(() =>
    routes.exec(
      "INSERT INTO whatsapp_routes(portfolio,bsuid,user_id,attempt_id,established) VALUES('portfolio',?,?,'dev-browser',1)",
      caller,
      subject
    )
  );
});

export const approve = Effect.fn(function* (runtime: Miniflare, request: Request) {
  const url = new URL(request.url),
    code = url.searchParams.get("code") ?? "";

  if (
    url.origin !== operator ||
    request.headers.has("origin") ||
    request.method !== "POST" ||
    url.pathname !== "/approve" ||
    !/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u.test(code)
  ) {
    return new Response(null, { status: 403 });
  }

  const response = yield* signedChat(
    runtime,
    "Aprueba el código de inicio de sesión " + code,
    caller
  );

  return new Response(null, { status: response.ok ? noContent : response.status });
});

export const forward = Effect.fn(function* (
  runtime: Miniflare,
  request: Request,
  onIngress?: () => void
) {
  const url = new URL(request.url);

  if (url.origin !== origin) return new Response(null, { status: 403 });
  const headers = new Headers(request.headers);
  headers.set("cf-connecting-ip", "127.0.0.1");
  const body = request.body === null ? undefined : yield* native(() => request.arrayBuffer());

  const init = {
    method: request.method,
    headers: Object.fromEntries(headers),
    body,
    redirect: "manual" as const,
    signal: request.signal,
  };

  const response = yield* native(() => {
    onIngress?.();

    return runtime.dispatchFetch(url.href, init);
  });

  return new Response(response.body, { status: response.status, headers: response.headers });
});

export class BrowserRuntime extends Context.Service<BrowserRuntime, Miniflare>()(
  "fidy-ai/scripts/dev-browser-api/BrowserRuntime"
) {
  static readonly make = Effect.gen(function* () {
    const create = yield* nativeBrowserPlatform;
    const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"]);

    const digest = Bun.spawnSync([
      process.execPath,
      "run",
      "--silent",
      "--cwd",
      "apps/server",
      "contracts:digest",
    ]);

    if (revision.exitCode !== 0 || digest.exitCode !== 0) {
      return yield* Effect.die("Could not resolve local release identity");
    }

    return yield* create(undefined, [], {
      BROWSER_ORIGIN: browserOrigins.acceptance,
      RELEASE_GIT_SHA: revision.stdout.toString().trim(),
      CONTRACT_DIGEST: digest.stdout.toString().trim(),
    });
  });

  static readonly layer = Layer.effect(this, this.make);
}

const loopback = Effect.gen(function* () {
  const runtime = yield* BrowserRuntime;
  yield* prepareBrowserUser(runtime, recurringUser);
  const run = Effect.runPromiseWith(yield* Effect.context<never>());

  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 4174,
    tls: {
      cert: Bun.file(Bun.env.PLAYWRIGHT_TLS_CERT ?? ""),
      key: Bun.file(Bun.env.PLAYWRIGHT_TLS_KEY ?? ""),
    },
    fetch: (req) => run(forward(runtime, req)),
  });

  const approvals = Bun.serve({
    hostname: "127.0.0.1",
    port: 4175,
    fetch: (req) => run(approve(runtime, req)),
  });

  yield* Effect.addFinalizer(() =>
    native(() => Promise.all([approvals.stop(true), api.stop(true)]))
  );

  return yield* Effect.never;
});

if (import.meta.main) {
  BunRuntime.runMain(
    loopback.pipe(
      Effect.scoped,
      Effect.provide(BrowserRuntime.layer.pipe(Layer.provideMerge(BunFileSystem.layer)))
    )
  );
}
