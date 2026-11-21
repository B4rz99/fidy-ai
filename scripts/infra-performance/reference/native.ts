import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, Option, Schema } from "effect";
import type { DurableObjectStorageHandle, Miniflare } from "miniflare";
import { BrowserRuntime, approve, forward, prepareBrowserUser } from "../../dev-browser-api";
import { seed, subject } from "./native-seed";
import { withReviewPressureSnapshot } from "./native-review-pressure";

const apiPort = 4174;

const operatorPort = 4175;

const timedResponse = Effect.fn(function* (
  runtime: Miniflare,
  owner: DurableObjectStorageHandle,
  request: Request
) {
  let started = Option.none<number>();

  const response = yield* forward(runtime, request, () => {
    started = Option.some(performance.now());
  });

  if (Option.isNone(started) || !new URL(request.url).pathname.startsWith("/transactions")) {
    const tooManyRequests = 429;

    return response.status === tooManyRequests
      ? yield* withReviewPressureSnapshot({ owner, user: subject, request, response })
      : response;
  }

  const body = yield* Effect.tryPromise(() => response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.set("x-reference-backend-ms", String(performance.now() - started.value));

  return new Response(body, { status: response.status, headers });
});

const accountability = Effect.fn(function* (
  owner: Awaited<ReturnType<Miniflare["unsafeGetDurableObjectStorage"]>>
) {
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

  if (Bun.env.FIDY_ASSESSMENT === "canonical-empty") {
    const capture = yield* Effect.tryPromise(() =>
      owner.exec(
        "SELECT s.id, s.transaction_id AS transactionId, s.kind, s.service_market AS serviceMarket, s.locale, s.time_zone AS timeZone, s.interpretation_revision AS interpretationRevision, s.created_at_ms AS createdAtMs, t.user_decisions AS decisions FROM source_attestations s JOIN transactions t ON t.user_id=s.user_id AND t.id=s.transaction_id WHERE s.user_id=? ORDER BY s.id LIMIT 9",
        subject
      )
    );

    const links = yield* Effect.tryPromise(() =>
      owner.exec(
        "SELECT first_transaction_id AS first, second_transaction_id AS second, visible_transaction_id AS visible, decided_at_ms AS decidedAtMs FROM transaction_reconciliation_decisions WHERE user_id=? AND state='linked' LIMIT 2",
        subject
      )
    );

    return Response.json({ capture, links });
  }

  return Response.json(counts);
});

const start = Effect.gen(function* () {
  const runtime = yield* BrowserRuntime;
  process.stdout.write("REFERENCE_STAGE user\n");
  yield* prepareBrowserUser(runtime, subject);

  const owner = yield* Effect.tryPromise(() =>
    runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: subject })
  );

  if (Bun.env.FIDY_ASSESSMENT !== "canonical-empty") {
    const fixture = yield* seed(owner, Bun.env.FIDY_ASSESSMENT ?? "");
    const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(fixture);
    process.stdout.write(`ASSESSMENT_SEED ${serialized}\n`);
  }

  const run = Effect.runPromiseWith(yield* Effect.context<never>());

  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: apiPort,
    tls: {
      cert: Bun.file(Bun.env.PLAYWRIGHT_TLS_CERT ?? ""),
      key: Bun.file(Bun.env.PLAYWRIGHT_TLS_KEY ?? ""),
    },
    fetch: (request) => run(timedResponse(runtime, owner, request)),
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
            return yield* accountability(owner);
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

BunRuntime.runMain(
  start.pipe(
    Effect.scoped,
    Effect.provide(
      BrowserRuntime.layer.pipe(
        Layer.provideMerge(
          Layer.effectDiscard(
            Effect.sync(() => process.stdout.write("REFERENCE_STAGE runtime\n"))
          ).pipe(Layer.provideMerge(BunFileSystem.layer))
        )
      )
    )
  )
);
