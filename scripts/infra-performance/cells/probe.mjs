// Exercise the frozen deployment's actual Ingress -> named erasure registry -> D1 route.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const output = process.argv[2];
const training = process.argv[3] === "train";
const baseline = resolve("apps/server");
const { Miniflare } = await import(Bun.resolveSync("miniflare", baseline));
const { currentDisclosureFor } = await import(resolve(baseline, "src/shell/consent/operations.ts"));
const origin = "https://app.fidyapp.com";
const experimentKey = crypto.randomUUID();
const ingressVersion = crypto.randomUUID();
const subject = "24000000-0000-4000-8000-000000000481";
const plan = await Bun.file(resolve(output, "plan.json")).json();
const text = (value) => ({ type: "text", value });
const coordinator = { type: "durable-object", worker: "core", exportName: "UserTransactionCoordinator" };
const environment = { BROWSER_ORIGIN: text(origin), RELEASE_GIT_SHA: text(plan.baseline), CONTRACT_DIGEST: text("a".repeat(64)) };
const config = async (name, entry, env, exports = {}) => ({
  config: {
    type: "worker", name, compatibilityDate: "2026-09-08",
    compatibilityFlags: ["enable_request_signal", "request_signal_passthrough", "nodejs_compat"],
    env, exports, manifest: { mainModule: "index.mjs", modules: {
      "index.mjs": { type: "esm", contents: await Bun.file(resolve(output, entry + ".mjs")).text() },
    } },
  },
});
const runtime = new Miniflare({ workers: [
  await config("ingress", "bounded-ingress", {
    EXPERIMENT_KEY: text(experimentKey), EXPERIMENT_DEADLINE: text(String(Date.now() + 180000)),
    CF_VERSION_METADATA: { type: "json", value: { id: ingressVersion } },
    ...environment, CORE: { type: "worker", worker: "core" }, ERASURE_REGISTRY_COORDINATOR: coordinator,
    LOCAL_CANONICAL_READ_BEARER: text(""), PAT_ADMISSION_KEY: text("test-only-admission-key-with-32-bytes"),
  }),
  await config("core", "metered-core", {
    ...environment, DB: { type: "d1", id: "isolated-d1-comparator" },
    ERASURE_REQUIRED: text("true"), ERASURE_BUCKET: { type: "r2", name: "isolated-erasure" },
    USER_TRANSACTION_COORDINATOR: coordinator, ERASURE_REGISTRY_COORDINATOR: coordinator,
    OPENAI_API_KEY: text(""), HOSTED_AI_MODEL: text("unused"), WHATSAPP_BUSINESS_PORTFOLIO_ID: text("acceptance-portfolio"),
  }, { UserTransactionCoordinator: { type: "durable-object", storage: "sqlite" } }),
] });
const metadata = { scope: "offline native comparator graph", fixture: plan.verified, baseline: plan.baseline };
const report = resolve(output, "probe.json");
const source = (path, options = {}) => runtime.dispatchFetch("https://fidy-2259-aaaaaaaaaaaa-ingress.offline.workers.dev" + path, {
  ...options, headers: { origin, "x-fidy-comparison-key": experimentKey, "cf-connecting-ip": "127.0.0.1", ...options.headers },
});
const estimates = {};
const request = async (path, options) => {
  const reply = await source(path, options);
  assert.equal(reply.headers.get("x-fidy-comparison-worker"), ingressVersion);
  const cost = JSON.parse(reply.headers.get("x-fidy-comparison-cost") ?? "null");
  assert.ok(cost && Number.isSafeInteger(cost.rowsRead) && Number.isSafeInteger(cost.rowsWritten), "Missing native " + path + " receipt: " + reply.status);
  const route = (options?.method ?? "GET") + " " + path;
  if (training) {
    assert.equal(cost.route, route);
    const previous = estimates[route];
    const caps = { ...previous?.statements };
    const maximum = { rowsRead: 0, rowsWritten: 0 };
    for (const entry of cost.calls) {
      const cap = caps[entry.key] ?? { rowsRead: 0, rowsWritten: 0 };
      cap.rowsRead = Math.max(cap.rowsRead, Math.ceil(entry.rowsRead * 1.7) + 20);
      cap.rowsWritten = Math.max(cap.rowsWritten, Math.ceil(entry.rowsWritten * 1.55) + 4);
      caps[entry.key] = cap;
    }
    for (const entry of cost.calls) {
      maximum.rowsRead += caps[entry.key].rowsRead;
      maximum.rowsWritten += caps[entry.key].rowsWritten;
    }
    estimates[route] = {
      maximum: { rowsRead: Math.max(maximum.rowsRead, previous?.maximum.rowsRead ?? 0), rowsWritten: Math.max(maximum.rowsWritten, previous?.maximum.rowsWritten ?? 0) },
      statements: { ...previous?.statements, ...caps },
    };
  }
  (metadata.requests ??= []).push({ route, rowsRead: cost.rowsRead, rowsWritten: cost.rowsWritten });
  return reply;
};
try {
  const db = await runtime.getD1Database("DB", "core");
  const bucket = await runtime.getR2Bucket("ERASURE_BUCKET", "core");
  const totals = { rowsRead: 0, rowsWritten: 0 };
  for (const batch of plan.batches) {
    const statements = batch.batch.map(({ sql, params }) => db.prepare(sql).bind(...params));
    const replies = await db.batch(statements);
    assert.equal(replies.length, statements.length);
    for (const { success, meta } of replies) {
      assert.ok(success && Number.isSafeInteger(meta.rows_read) && Number.isSafeInteger(meta.rows_written));
      totals.rowsRead += meta.rows_read;
      totals.rowsWritten += meta.rows_written;
    }
  }
  metadata.preparation = totals;
  await bucket.put("recovery/generation", "initial");
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE users SET whatsapp_portfolio_id=?,whatsapp_bsuid=?,whatsapp_verified_at_ms=?,trial_started_at_ms=?,trial_ends_at_ms=? WHERE id=?")
      .bind("acceptance-portfolio", "CO.Reference", now, now, now + 604800000, subject),
    db.prepare("INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant',?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), subject, JSON.stringify(currentDisclosureFor()), "disclosure", "decision", now, now),
  ]);
  assert.equal((await source("/transactions?limit=25", { headers: { "x-fidy-comparison-key": "wrong" } })).status, 403);
  assert.equal((await source("/transactions?limit=26")).status, 403);
  const start = await request("/web/pairings", { method: "POST" });
  assert.equal(start.status, 200, "start Browser Login");
  const pair = await start.json();
  await db.prepare("UPDATE browser_login_pairings SET approval_portfolio_id=?,approval_message_id=?,approval_user_id=? WHERE id=? AND state='pending_approval' AND approval_message_id IS NULL")
    .bind("acceptance-portfolio", crypto.randomUUID(), subject, pair.pairingId).run();
  const redeem = await request("/web/pairings/redeem", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingId: pair.pairingId, privateVerifier: pair.privateVerifier }),
  });
  assert.ok(redeem.ok, "redeem paired Browser Login");
  const cookie = redeem.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("__Host-fidy_session="));
  const handshake = await request("/web/session/binding", { headers: { cookie } });
  assert.equal(handshake.status, 200);
  const { binding } = await handshake.json();
  assert.ok(binding);
  let responseSha256;
  const firstOffer = performance.now();
  for (let index = 0; index < 30; index++) {
    await Bun.sleep(Math.max(0, firstOffer + index * 1000 - performance.now()));
    const reply = await request("/transactions?limit=25", { headers: { cookie, "Fidy-Session-Binding": binding } });
  assert.equal(reply.status, 200, "authenticated history on deployed graph");
  const body = await reply.text();
  const { data } = JSON.parse(body);
  assert.deepEqual(data.map(({ id }) => id), [0, 2, 3, 4, 5, 6, 7].map(i => "81000000-0000-4000-8000-" + String(i).padStart(12, "0")));
    const hash = createHash("sha256").update(body).digest("hex");
    if (responseSha256) assert.equal(hash, responseSha256);
    responseSha256 = hash;
  }
  const counts = await db.prepare("SELECT count(*) AS n FROM audit_entries WHERE user_id=? AND operation='transactions.listTransactions' AND outcome='success'").bind(subject).first();
  assert.equal(counts.n, 30);
  if (training) await Bun.write(resolve(output, "limits.json"), JSON.stringify(estimates, null, 2));
  Object.assign(metadata, { result: "passed", responseSha256, auditReads: counts.n });
} finally {
  await Bun.write(report, JSON.stringify(metadata, null, 2));
  await runtime.dispose();
}
