import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Option, Schema } from "effect";
import type { Miniflare } from "miniflare";
import { approve, forward, makeBrowserRuntime, prepareBrowserUser } from "../../dev-browser-api";
import { seed, subject } from "./native-seed";

const apiPort = 4174;
const operatorPort = 4175;
const timedResponse = Effect.fn(function* (runtime: Miniflare, request: Request) {
  let started = Option.none<number>();
  const response = yield* forward(runtime, request, () => {
    started = Option.some(performance.now());
  });
  if (Option.isNone(started) || !new URL(request.url).pathname.startsWith("/transactions")) {
    return response;
  }
  const body = yield* Effect.tryPromise(() => response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.set("x-reference-backend-ms", String(performance.now() - started.value));
  return new Response(body, { status: response.status, headers });
});
const start = Effect.gen(function* () {
  process.stdout.write("REFERENCE_STAGE runtime\n");
  const runtime = yield* makeBrowserRuntime;
  process.stdout.write("REFERENCE_STAGE user\n");
  yield* prepareBrowserUser(runtime, subject);
  const owner = yield* Effect.tryPromise(() =>
    runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: subject })
  );
  const fixture = yield* seed(owner, Bun.env.FIDY_ASSESSMENT ?? "");
  const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(fixture);
  process.stdout.write(`ASSESSMENT_SEED ${serialized}\n`);
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: apiPort,
    tls: {
      cert: Bun.file(Bun.env.PLAYWRIGHT_TLS_CERT ?? ""),
      key: Bun.file(Bun.env.PLAYWRIGHT_TLS_KEY ?? ""),
    },
    fetch: (request) => run(timedResponse(runtime, request)),
  });
  const operator = Bun.serve({
    hostname: "127.0.0.1",
    port: operatorPort,
    fetch: (request) =>
      run(
        Effect.gen(function* () {
          const url = new URL(request.url);
          if (url.origin !== `http://127.0.0.1:${operatorPort}` || request.headers.has("origin")) {
            return new Response(null, { status: 403 });
          }
          if (url.pathname === "/assessment/prepare" && ["POST", "GET"].includes(request.method)) {
            return Response.json({ status: "ready" });
          }
          if (url.pathname === "/assessment/accountability" && request.method === "GET") {
            const [counts] = yield* Effect.tryPromise(() =>
              owner.exec(
                `SELECT
          (SELECT count(*) FROM audit_entries WHERE user_id=?1 AND operation='transactions.listTransactions' AND outcome='success') AS reads,
          (SELECT count(*) FROM audit_entries WHERE user_id=?1 AND operation='transactions.updateTransaction' AND outcome='success') AS corrections,
          (SELECT COALESCE(sum(units),0) FROM commercial_allowance_consumptions WHERE user_id=?1 AND allowance='canonical_call') AS units,
          (SELECT count(*) FROM canonical_request_receipts WHERE user_id=?1) AS receipts`,
                subject
              )
            );
            return Response.json(counts);
          }
          return yield* approve(runtime, request);
        })
      ),
  });
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(() => Promise.all([operator.stop(true), api.stop(true)])).pipe(Effect.orDie)
  );
  return yield* Effect.never;
});
await Effect.runPromise(start.pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)));
