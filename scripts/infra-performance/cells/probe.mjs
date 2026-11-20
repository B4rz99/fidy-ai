// Exercise the frozen deployment's actual Ingress -> named erasure registry -> D1 route.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { Schema } from "effect";

/** @import { Call, Cost, Limits, StatementReply } from "./contracts.d.mts" */
/** @typedef {{method?: string, headers?: Record<string, string>, body?: string}} Options */
const Rows = Schema.Struct({ rowsRead: Schema.Int, rowsWritten: Schema.Int });
const rowReceipt = Schema.decodeUnknownSync(
  Schema.Struct({
    ...Rows.fields,
    route: Schema.optional(Schema.String),
    calls: Schema.optional(Schema.Array(Schema.Struct({ ...Rows.fields, key: Schema.String }))),
  })
);
const calibration = Schema.decodeUnknownSync(
  Schema.Struct({
    baseline: Schema.String,
    verified: Schema.Record(Schema.String, Schema.Int),
    batches: Schema.Array(
      Schema.Struct({
        batch: Schema.Array(
          Schema.Struct({
            sql: Schema.String,
            params: Schema.Array(Schema.Unknown),
            check: Schema.optional(Schema.String),
          })
        ),
      })
    ),
  })
);
const routeBounds = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Struct({ maximum: Rows }))
);
const paired = Schema.decodeUnknownSync(
  Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
);
const session = Schema.decodeUnknownSync(Schema.Struct({ binding: Schema.String }));
const history = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) })
);

const shaWidth = 64;
const setupLifetimeMs = 180000;
const trialMs = 604800000;
const secondMs = 1000;
const sampleCount = 1;
const success = 200;
const forbidden = 403;
const uuidDigits = 12;
const fixtureOriginalCount = 8;
const readFactor = 1.7;
const writeFactor = 1.55;
const extraReads = 20;
/** @param {Cost} entry Native row observation. */
const headroom = (entry) => ({
  rowsRead: Math.ceil(entry.rowsRead * readFactor) + extraReads,
  rowsWritten: Math.ceil(entry.rowsWritten * writeFactor) + 4,
});
/**
 * @param {Cost} left Earlier maximum.
 * @param {Cost} right Latest observation.
 */
const maximumOf = (left, right) => ({
  rowsRead: Math.max(left.rowsRead, right.rowsRead),
  rowsWritten: Math.max(left.rowsWritten, right.rowsWritten),
});
/**
 * @param {Cost} left Accumulated row counts.
 * @param {Cost} right Newly observed rows.
 */
const add = (left, right) => ({
  rowsRead: left.rowsRead + right.rowsRead,
  rowsWritten: left.rowsWritten + right.rowsWritten,
});
const empty = () => ({ rowsRead: 0, rowsWritten: 0 });
/**
 * @template T
 * @param {ReadonlyArray<T>} items Bounded work.
 * @param {(item:T) => Promise<void>} visit Native operation.
 */
const eachInOrder = (items, visit) =>
  items.reduce((previous, item) => previous.then(() => visit(item)), Promise.resolve());
const output = process.argv[2];
const training = process.argv[3] === "train";
const refuse = process.argv[3] === "refuse";
const interrupted = process.argv[3] === "interrupt-preparation";
const interruption = new Error("Runner interruption after verified canonical setup");

const disclosure = await Bun.file(resolve(output, "disclosure.json")).text();
const origin = "https://app.fidyapp.com";
const experimentKey = crypto.randomUUID();
const ingressVersion = crypto.randomUUID();
const expectation = Bun.file(resolve(output, "expected.json"));
const expected = (await expectation.exists())
  ? Schema.decodeUnknownSync(
      Schema.Struct({
        history: Schema.Unknown,
        inspections: Schema.Record(Schema.String, Schema.Unknown),
      })
    )(await expectation.json())
  : undefined;
const inspections = Object.entries(expected?.inspections ?? {});
const subject = "24000000-0000-4000-8000-000000000481";
const plan = calibration(await Bun.file(resolve(output, "plan.json")).json());
/**
 * @param {string} value Text binding.
 * @returns {{type:"text",value:string}}
 */
const text = (value) => ({ type: "text", value });
/** @type {{type:"durable-object",worker:string,exportName:string}} */
const coordinator = {
  type: "durable-object",
  worker: "core",
  exportName: "UserTransactionCoordinator",
};
const environment = {
  BROWSER_ORIGIN: text(origin),
  RELEASE_GIT_SHA: text(plan.baseline),
  CONTRACT_DIGEST: text("a".repeat(shaWidth)),
};
/**
 * @param {string} name Isolated Worker name.
 * @param {string} entry Compiled entrypoint.
 * @param {Pick<import("miniflare").MiniflareWorkerConfig,"env" | "exports">} options Native configuration.
 * @returns {Promise<{config: import("miniflare").MiniflareWorkerConfig}>}
 */
const config = async (name, entry, { env, exports = {} }) => ({
  config: {
    type: "worker",
    name,
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["enable_request_signal", "request_signal_passthrough", "nodejs_compat"],
    env,
    exports,
    manifest: {
      mainModule: "index.mjs",
      modules: {
        "index.mjs": {
          type: "esm",
          contents: await Bun.file(resolve(output, entry + ".mjs")).text(),
        },
      },
    },
  },
});
const runtime = new Miniflare({
  workers: [
    await config("ingress", "bounded-ingress", {
      env: {
        EXPERIMENT_KEY: text(experimentKey),
        EXPERIMENT_DEADLINE: text(String(Date.now() + setupLifetimeMs)),
        CF_VERSION_METADATA: { type: "json", value: { id: ingressVersion } },
        ...environment,
        CORE: { type: "worker", worker: "core" },
        ERASURE_REGISTRY_COORDINATOR: coordinator,
        LOCAL_CANONICAL_READ_BEARER: text(""),
        PAT_ADMISSION_KEY: text("test-only-admission-key-with-32-bytes"),
      },
    }),
    await config("core", "metered-core", {
      env: {
        ...environment,
        DB: { type: "d1", id: "isolated-d1-comparator" },
        ERASURE_REQUIRED: text("true"),
        ERASURE_BUCKET: { type: "r2", name: "isolated-erasure" },
        USER_TRANSACTION_COORDINATOR: coordinator,
        ERASURE_REGISTRY_COORDINATOR: coordinator,
        OPENAI_API_KEY: text(""),
        HOSTED_AI_MODEL: text("unused"),
        WHATSAPP_BUSINESS_PORTFOLIO_ID: text("acceptance-portfolio"),
      },
      exports: { UserTransactionCoordinator: { type: "durable-object", storage: "sqlite" } },
    }),
  ],
});
/** @type {Array<Cost & {route: string}>} */
const requests = [];
/** @type {Record<string, unknown>} */
const metadata = {
  requests,
  scope: "offline native comparator graph",
  fixture: plan.verified,
  baseline: plan.baseline,
};
const reportName = interrupted ? "interruption.json" : "probe.json";
const report = resolve(output, refuse ? "refusal.json" : reportName);
/**
 * @param {string} path Scoped path.
 * @param {Options} options Request options.
 */
const source = (path, options = {}) =>
  runtime.dispatchFetch("https://fidy-2259-aaaaaaaaaaaa-ingress.offline.workers.dev" + path, {
    ...options,
    headers: {
      origin,
      "x-fidy-comparison-key": experimentKey,
      "cf-connecting-ip": "127.0.0.1",
      ...options.headers,
    },
  });
/** @type {Limits} */
const estimates = {};
/**
 * @param {string} route Canonical method and path.
 * @param {ReadonlyArray<Call>} calls Native calls for the request.
 */
const learn = (route, calls) => {
  const previous = estimates[route] ?? { maximum: empty(), statements: {} };
  const statements = { ...previous.statements };
  for (const entry of calls) {
    statements[entry.key] = maximumOf(statements[entry.key] ?? empty(), headroom(entry));
  }
  const maximum = calls.reduce((total, entry) => add(total, statements[entry.key]), empty());
  estimates[route] = { maximum: maximumOf(previous.maximum, maximum), statements };
};
/**
 * @param {string} path Registered path.
 * @param {Options} [options] Native request.
 */
const request = async (path, options) => {
  const reply = await source(path, options);
  assert.equal(reply.headers.get("x-fidy-comparison-worker"), ingressVersion);
  const cost = rowReceipt(JSON.parse(reply.headers.get("x-fidy-comparison-cost") ?? "null"));
  assert.ok(
    Number.isSafeInteger(cost.rowsRead) && Number.isSafeInteger(cost.rowsWritten),
    "Missing native receipt: " + reply.status
  );
  const route = (options?.method ?? "GET") + " " + path;
  if (training) {
    assert.equal(cost.route, route);
    assert.ok(cost.calls);
    learn(route, cost.calls);
  }
  requests.push({
    route,
    rowsRead: cost.rowsRead,
    rowsWritten: cost.rowsWritten,
  });
  return reply;
};
if (process.argv[3] === "owner-pipe") {
  try {
    const { serveOwnerPipe } = await import("./owner-pipe.mjs");
    await serveOwnerPipe(runtime, experimentKey, ingressVersion);
  } finally {
    await runtime.dispose();
  }
  process.exit(0);
}
try {
  const db = await runtime.getD1Database("DB", "core");
  const bucket = await runtime.getR2Bucket("ERASURE_BUCKET", "core");
  const totals = { rowsRead: 0, rowsWritten: 0 };
  /** @type {Array<{phase:string,actual:Cost,maximum:Cost}>} */
  const sqlBatches = [];
  /**
   * @param {string} phase Preparation phase.
   * @param {ReadonlyArray<{success:boolean,meta:{rows_read:number,rows_written:number}}>} replies Native D1 results.
   */
  const account = (phase, replies) => {
    const actual = { rowsRead: 0, rowsWritten: 0 };
    for (const { success, meta } of replies) {
      assert.ok(
        success && Number.isSafeInteger(meta.rows_read) && Number.isSafeInteger(meta.rows_written)
      );
      actual.rowsRead += meta.rows_read;
      actual.rowsWritten += meta.rows_written;
    }
    sqlBatches.push({
      phase,
      actual,
      maximum: headroom(actual),
    });
    return actual;
  };
  await eachInOrder(plan.batches, async (batch) => {
    const statements = batch.batch.map(({ sql, params }) => db.prepare(sql).bind(...params));
    const replies = await db.batch(statements);
    assert.equal(replies.length, statements.length);
    for (const [index, row] of replies.entries()) {
      const expectedDigest = batch.batch[index]?.check;
      if (expectedDigest) {
        const records = Schema.decodeUnknownSync(
          Schema.Array(Schema.Record(Schema.String, Schema.Json))
        )(row.results);
        const stable = records.map((record) =>
          Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
        );
        assert.equal(
          createHash("sha256").update(JSON.stringify(stable)).digest("hex"),
          expectedDigest,
          "Schema or seed verification mismatch"
        );
      }
    }
    const actual = account("calibration", replies);
    totals.rowsRead += actual.rowsRead;
    totals.rowsWritten += actual.rowsWritten;
  });
  metadata.preparation = totals;
  await bucket.put("recovery/generation", "initial");
  const now = Date.now();
  account(
    "identity",
    await db.batch([
      db
        .prepare(
          "UPDATE users SET whatsapp_portfolio_id=?,whatsapp_bsuid=?,whatsapp_verified_at_ms=?,trial_started_at_ms=?,trial_ends_at_ms=? WHERE id=?"
        )
        .bind("acceptance-portfolio", "CO.Reference", now, now, now + trialMs, subject),
      db
        .prepare(
          "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant',?,?,?,?,?,?,?)"
        )
        .bind(crypto.randomUUID(), subject, disclosure, "disclosure", "decision", now, now),
    ])
  );
  assert.equal(
    (await source("/transactions?limit=25", { headers: { "x-fidy-comparison-key": "wrong" } }))
      .status,
    forbidden
  );
  assert.equal((await source("/transactions?limit=26")).status, forbidden);
  const start = await request("/web/pairings", { method: "POST" });
  assert.equal(start.status, success, "start Browser Login");
  const pair = paired(await start.json());
  account("approval", [
    await db
      .prepare(
        "UPDATE browser_login_pairings SET approval_portfolio_id=?,approval_message_id=?,approval_user_id=? WHERE id=? AND state='pending_approval' AND approval_message_id IS NULL"
      )
      .bind("acceptance-portfolio", crypto.randomUUID(), subject, pair.pairingId)
      .run(),
  ]);
  const redeem = await request("/web/pairings/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingId: pair.pairingId, privateVerifier: pair.privateVerifier }),
  });
  assert.ok(redeem.ok, "redeem paired Browser Login");
  const cookie = redeem.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("__Host-fidy_session="));
  const handshake = await request("/web/session/binding", { headers: { cookie } });
  assert.equal(handshake.status, success);
  const { binding } = session(await handshake.json());
  assert.ok(binding);
  if (interrupted) {
    assert.ok(expected && inspections.length === fixtureOriginalCount);
    const reply = await request("/transactions?limit=25", {
      headers: { cookie, "Fidy-Session-Binding": binding },
    });
    assert.equal(reply.status, success);
    assert.deepEqual(await reply.json(), expected.history);
    assert.ok(await bucket.head("recovery/generation"));
    const endpoint = await runtime.ready;
    assert.equal(endpoint.hostname, "127.0.0.1");
    metadata.localPort = Number(endpoint.port);
    metadata.result = "interrupted after verified canonical setup";
    throw interruption;
  }
  if (refuse) {
    const denied = await source("/transactions?limit=25", {
      headers: { cookie, "Fidy-Session-Binding": binding },
    });
    const unavailable = 503;
    assert.equal(denied.status, unavailable, "a zero native ceiling must refuse before Audit");
    assert.equal(denied.headers.get("x-fidy-comparison-cost"), null);
    const noRead = await db
      .prepare(
        "SELECT count(*) AS total FROM audit_entries WHERE user_id=? AND operation='transactions.listTransactions'"
      )
      .bind(subject)
      .first("total");
    assert.equal(noRead, 0);
    metadata.result = "zero ceiling refused authenticated work";
  } else {
    await eachInOrder(inspections, async ([id, detail]) => {
      await Bun.sleep(secondMs);
      const reply = await request("/transactions/" + id, {
        headers: { cookie, "Fidy-Session-Binding": binding },
      });
      assert.equal(reply.status, success);
      assert.deepEqual(await reply.json(), detail);
    });
    metadata.comparedInspections = inspections.length;
    const browserRoutes=[];
    const budget=training ? {} : routeBounds(await Bun.file(resolve(output,"limits.json")).json());
    const {runBrowser}=await import("../hosted-browser/signed-feasibility.mjs");
    const month="/transactions?limit=25&from=2026-11-01T05%3A00%3A00.000Z&to=2026-12-01T05%3A00%3A00.000Z";
    await runBrowser({variant:"d1",origins:{browser:origin,api:"https://api.fidyapp.com"},cookie,expected:expected.history,observations:30,
      forward:async r=>{const u=new URL(r.url);return source(u.pathname+u.search,{method:r.method,headers:Object.fromEntries(r.headers)})},
      afterRequest:(key,response,ev)=>{
        if(key.startsWith("OPTIONS ")){assert.equal(response.status,204);return;}
        const cost=rowReceipt(JSON.parse(response.headers.get("x-fidy-comparison-cost")));
        if(training) learn(key,cost.calls);
        const cap=(training?estimates:budget)[key].maximum;
        for(const field of ["rowsRead","rowsWritten"])assert.ok(cost[field]<=cap[field]);
        browserRoutes.push(key);
        Object.assign(ev,{actual:cost.rowsWritten,maximum:cap.rowsWritten,...(training?{nativeCalls:cost.calls.length}:{})});
      }
    });
    const expectedRoutes=["GET /web/session/binding?context=transactions","GET /web/session/binding","GET /ingestion/review-workspace?limit=0&status=pending",...Array.from({length:30},()=>["GET "+month,"GET /user"]).flat()];
    assert.deepEqual(browserRoutes.sort(),expectedRoutes.sort());
    const check=await db.batch([
      db.prepare("SELECT operation,outcome,count(*) AS entries FROM audit_entries WHERE user_id=? AND session_id=? GROUP BY operation,outcome ORDER BY operation,outcome").bind(subject,binding),
      db.prepare("SELECT (SELECT COALESCE(sum(units),0) FROM commercial_allowance_consumptions WHERE user_id=?1 AND allowance='canonical_call') AS units,(SELECT count(*) FROM canonical_request_replays WHERE user_id=?1 AND state='completed') AS receipts").bind(subject)
    ]);
    account("audit",check);metadata.sessionAudit=check[0].results;
    assert.equal(check[0].results.find(r=>r.operation==="transactions.listTransactions"&&r.outcome==="success")?.entries,31);
    assert.equal(check[0].results.find(r=>r.operation==="transactions.getTransaction"&&r.outcome==="success")?.entries,8);
    assert.equal(check[0].results.filter(r=>r.operation==="transactions.updateTransaction").length,0);
    assert.deepEqual(check[1].results,[{units:0,receipts:0}]);
    metadata.commercial=check[1].results[0];
    metadata.sqlBatches=sqlBatches;
    const routes=[...requests.map(r=>r.route),...browserRoutes];
    const allCaps=sqlBatches.map(b=>b.maximum).concat(routes.map(name=>(training?estimates:budget)[name].maximum));
    metadata.fullEstimate=Object.fromEntries(["rowsRead","rowsWritten"].map(k=>[k,allCaps.reduce((a,b)=>a+b[k],0)]));
    metadata.routes=Object.fromEntries([...new Set(routes)].map(name=>[name,{count:routes.filter(r=>r===name).length,cap:(training?estimates:budget)[name].maximum}]));
    assert.ok(metadata.fullEstimate.rowsRead<=100000&&metadata.fullEstimate.rowsWritten<=5000);
    if (training) {
      await Bun.write(resolve(output, "limits.json"), JSON.stringify(estimates, null, 2));
    }
    metadata.result="passed";
  }
} catch (error) {
  if (!interrupted || error !== interruption) throw error;
} finally {
  try {
    await runtime.dispose();
    if (interrupted) metadata.disposed = true;
  } finally {
    await Bun.write(report, JSON.stringify(metadata, null, 2));
  }
}
