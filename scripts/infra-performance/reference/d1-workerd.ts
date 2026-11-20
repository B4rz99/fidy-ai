import assert from "node:assert/strict";
import { Effect, Option } from "effect";
import type { Miniflare } from "miniflare";
import {
  appendReviewTrace,
  isReviewTraceRequest,
} from "../../../apps/server/cloudflare/runtime/review-request-trace";
import { forward } from "../../dev-browser-api";
import { d1Platform } from "../load/d1.mjs";
import { seed, subject } from "./native-seed";

const frozenWebPort = 4173;
const offset = Number(Bun.env.REFERENCE_WEB_PORT);
const apiPort = offset + 1;
const operatorPort = offset + 2;
const origin = `http://127.0.0.1:${operatorPort}`;
const account = "CO.ReviewReference";

const publicResponse = Effect.fn(function* (runtime: Miniflare, request: Request) {
  let started = performance.now();
  const reply = yield* forward(runtime, request, () => {
    started = performance.now();
  });
  if (isReviewTraceRequest(request)) {
    return appendReviewTrace(reply, Option.some({ "review-workerd": performance.now() - started }));
  }
  if (!new URL(request.url).pathname.startsWith("/transactions")) return reply;
  const bytes = yield* Effect.tryPromise(() => reply.arrayBuffer());
  const headers = new Headers(reply.headers);
  headers.set("x-reference-backend-ms", String(performance.now() - started));
  return new Response(bytes, { status: reply.status, headers });
});

type Platform = Awaited<ReturnType<typeof d1Platform>>;
const operatorResponse = async (platform: Platform, request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.origin !== origin || request.headers.has("origin")) {
    return new Response(null, { status: 403 });
  }
  const operation = `${request.method} ${url.pathname}`;
  if (["POST /assessment/prepare", "GET /assessment/prepare"].includes(operation)) {
    return Response.json({ status: "ready" });
  }
  if (operation === "GET /assessment/accountability") {
    const [counts] = await platform.owner.exec(
      `SELECT
          (SELECT count(*) FROM audit_entries WHERE user_id=?1 AND operation='transactions.listTransactions' AND outcome='success') AS reads,
          (SELECT count(*) FROM audit_entries WHERE user_id=?1 AND operation='transactions.updateTransaction' AND outcome='success') AS corrections,
          (SELECT COALESCE(sum(units),0) FROM commercial_allowance_consumptions WHERE user_id=?1 AND allowance='canonical_call') AS units,
          (SELECT count(*) FROM canonical_request_replays WHERE user_id=?1) AS receipts`,
      subject
    );
    return Response.json(counts);
  }
  const pairingId = url.searchParams.get("pairingId") ?? "";
  if (operation === "POST /approve" && /^[a-f0-9-]{36}$/u.test(pairingId)) {
    await platform.approve(subject, { pairingId });
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 404 });
};

const start = Effect.gen(function* () {
  const root = Bun.env.FIDY_REFERENCE_D1_ROOT;
  assert.ok(root && offset === frozenWebPort && Bun.env.FIDY_ASSESSMENT === "extreme");
  const platform = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      d1Platform(root, [], { browserOrigin: `https://127.0.0.1:${offset}`, referenceOverlay: true })
    ),
    ({ runtime }) => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
  );
  yield* Effect.tryPromise(() => platform.prepare(subject, account));
  const fixture = yield* seed(platform.owner, "extreme", {
    subject,
    index: 0,
    d1: true,
    mixedReview: false,
  });
  process.stdout.write(`ASSESSMENT_SEED ${JSON.stringify(fixture)}\n`);
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: apiPort,
    tls: {
      cert: Bun.file(Bun.env.PLAYWRIGHT_TLS_CERT ?? ""),
      key: Bun.file(Bun.env.PLAYWRIGHT_TLS_KEY ?? ""),
    },
    fetch: (request) => Effect.runPromise(publicResponse(platform.runtime, request)),
  });
  const operator = Bun.serve({
    hostname: "127.0.0.1",
    port: operatorPort,
    fetch: (request) => operatorResponse(platform, request),
  });
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(() => Promise.all([operator.stop(true), api.stop(true)])).pipe(Effect.orDie)
  );
  return yield* Effect.never;
});
await Effect.runPromise(start.pipe(Effect.scoped));
