import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { approve, forward, makeBrowserRuntime, prepareBrowserUser } from "../../dev-browser-api";
import { native } from "../../../apps/server/cloudflare/user-store.test-fixture";
import { seed, subject } from "./native-seed";

const apiPort = 4174;
const operatorPort = 4175;
const start = Effect.gen(function* () {
  const runtime = yield* makeBrowserRuntime;
  yield* prepareBrowserUser(runtime, subject);
  const owner = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: subject })
  );
  const fixture = yield* seed(owner, Bun.env.FIDY_ASSESSMENT ?? "");
  process.stdout.write(`ASSESSMENT_SEED ${JSON.stringify(fixture)}\n`);
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: apiPort,
    tls: {
      cert: Bun.file(Bun.env.PLAYWRIGHT_TLS_CERT ?? ""),
      key: Bun.file(Bun.env.PLAYWRIGHT_TLS_KEY ?? ""),
    },
    async fetch(request) {
      const started = performance.now();
      const response = await Effect.runPromise(forward(runtime, request));
      if (!new URL(request.url).pathname.startsWith("/transactions")) return response;
      const body = await response.arrayBuffer();
      const headers = new Headers(response.headers);
      headers.set("x-reference-backend-ms", String(performance.now() - started));
      return new Response(body, { status: response.status, headers });
    },
  });
  const operator = Bun.serve({
    hostname: "127.0.0.1",
    port: operatorPort,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin !== `http://127.0.0.1:${operatorPort}` || request.headers.has("origin")) {
        return new Response(null, { status: 403 });
      }
      if (url.pathname === "/assessment/prepare" && ["POST", "GET"].includes(request.method)) {
        return Response.json({ status: "ready" });
      }
      if (url.pathname === "/assessment/accountability" && request.method === "GET") {
        const [counts] = await owner.exec(
          `SELECT
          (SELECT count(*) FROM audit_entries WHERE user_id=?1 AND operation='transactions.listTransactions' AND outcome='success') AS reads,
          (SELECT count(*) FROM audit_entries WHERE user_id=?1 AND operation='transactions.updateTransaction' AND outcome='success') AS corrections,
          (SELECT COALESCE(sum(units),0) FROM commercial_allowance_consumptions WHERE user_id=?1 AND allowance='canonical_call') AS units,
          (SELECT count(*) FROM canonical_request_receipts WHERE user_id=?1) AS receipts`,
          subject
        );
        return Response.json(counts);
      }
      return approve(runtime, request);
    },
  });
  yield* Effect.addFinalizer(() =>
    native(() => Promise.all([operator.stop(true), api.stop(true)]))
  );
  return yield* Effect.never;
});
await Effect.runPromise(start.pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)));
