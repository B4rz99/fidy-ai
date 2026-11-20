import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { makeBrowserRuntime, prepareBrowserUser } from "../../dev-browser-api.ts";
import { signedChat } from "../../../apps/server/cloudflare/signed-whatsapp.test-fixture.ts";
import { seed } from "../reference/native-seed.ts";
import { baseline, d1Platform, origin } from "./d1.mjs";

const [root, directory, size = "extreme"] = process.argv.slice(2);
assert.ok(["extreme", "production"].includes(size));
const users = 20,
  samples = 30;
const history = "/transactions?limit=25";
const write = (name, data) =>
  Bun.write(resolve(directory, name + ".json"), JSON.stringify(data, null, 2));
const record = (name, data) =>
  appendFileSync(resolve(directory, name + ".jsonl"), JSON.stringify(data) + "\n");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = (index, ordinal) =>
  "81000000-0000-4000-80" +
  index.toString(16).padStart(2, "0") +
  "-" +
  String(ordinal).padStart(12, "0");
const run = Effect.runPromise;
const execute = async (runtime, subject, path, options = {}) =>
  runtime.dispatchFetch("https://api.fidyapp.com" + path, {
    ...options,
    signal: AbortSignal.timeout(60000),
    headers: {
      origin,
      "cf-connecting-ip": "192.0.2." + (subject.index + 1),
      ...subject.headers,
      ...options.headers,
    },
  });
async function authenticate(platform, subject) {
  const { runtime } = platform;
  const start = await execute(runtime, subject, "/web/pairings", { method: "POST" });
  assert.equal(start.status, 200, "Browser Login pairing");
  const pair = await start.json();
  await platform.approve(subject, pair);
  const redeem = await execute(runtime, subject, "/web/pairings/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingId: pair.pairingId, privateVerifier: pair.privateVerifier }),
  });
  assert.equal(redeem.status, 200, "Browser Login redemption");
  const cookie = redeem.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("__Host-fidy_session="));
  const response = await execute(runtime, subject, "/web/session/binding", { headers: { cookie } });
  assert.equal(response.status, 200, "Browser Session binding");
  const { binding } = await response.json();
  assert.ok(binding);
  subject.headers = { cookie, "fidy-session-binding": binding };
}
async function observe(platform, subject, row, scheduled, journey) {
  const start = performance.now();
  const responses = [];
  try {
    const call = async (path, options) => {
      const result = await execute(platform.runtime, subject, path, options);
      const bytes = new Uint8Array(await result.arrayBuffer());
      responses.push({ status: result.status, bytes, end: performance.now() });
      return { status: result.status, body: JSON.parse(new TextDecoder().decode(bytes)) };
    };
    await journey(call);
    const end = responses.at(-1).end;
    Object.assign(row, {
      ok: true,
      status: responses.at(-1).status,
      bytes: responses.reduce((n, r) => n + r.bytes.length, 0),
      digest: responses.map((r) => hash(r.bytes)).join("."),
      dispatchMs: end - start,
      scheduledMs: end - scheduled,
      scheduled,
      dispatched: start,
      completedAt: end,
    });
  } catch (error) {
    Object.assign(row, {
      ok: false,
      status: responses.at(-1)?.status,
      error: error.name,
      scheduled,
      dispatched: start,
      completedAt: performance.now(),
    });
  }
  record("attempts", row);
}
async function accountability(variant, subject) {
  const receipt = variant === "do" ? "canonical_request_receipts" : "canonical_request_replays";
  const [counts] = await subject.owner.exec(
    `SELECT
    (SELECT count(*) FROM audit_entries WHERE user_id=?1 AND operation='transactions.listTransactions' AND outcome='success') AS reads,
    (SELECT count(*) FROM audit_entries WHERE user_id=?1 AND operation='transactions.updateTransaction' AND outcome='success') AS corrections,
    (SELECT COALESCE(sum(units),0) FROM commercial_allowance_consumptions WHERE user_id=?1 AND allowance='canonical_call') AS units,
    (SELECT count(*) FROM ${receipt} WHERE user_id=?1) AS receipts`,
    subject.id
  );
  return counts;
}
async function measure(native, d1) {
  const variants = {
    d1: { runtime: d1.runtime, subjects: [], approve: (s, p) => d1.approve(s.id, p) },
    do: {
      runtime: native,
      subjects: [],
      approve: async (s, p) => {
        const r = await run(
          signedChat(native, "Aprueba el código de inicio de sesión " + p.publicCode, s.caller)
        );
        assert.ok(r.ok, "Signed WhatsApp approval");
      },
    },
  };
  for (let index = 0; index < users; index++) {
    const user = "24000000-0000-4000-8000-" + String(481 + index).padStart(12, "0");
    const caller = "CO.Load" + index;
    for (const [variant, platform] of Object.entries(variants)) {
      console.log("Preparing", variant, "User", index + 1, "of", users);
      if (variant === "do") await run(prepareBrowserUser(native, user, caller));
      else await d1.prepare(user, caller);
      const owner =
        variant === "do"
          ? await native.unsafeGetDurableObjectStorage("core", "UserStore", { name: user })
          : d1.owner;
      const state = await run(seed(owner, size, user, index, variant === "d1"));
      record("fixtures", { variant, user, index, ...state });
      platform.subjects.push({ id: user, index, caller, owner });
    }
  }
  const audits = {};
  for (const [variant, platform] of Object.entries(variants)) {
    for (const subject of platform.subjects) {
      await authenticate(platform, subject);
      const warm = await execute(platform.runtime, subject, history);
      assert.equal(warm.status, 200, "Authenticated warm-up");
      const bytes = new Uint8Array(await warm.arrayBuffer());
      subject.initial = JSON.parse(new TextDecoder().decode(bytes));
      subject.digest = hash(bytes);
      const length = size === "extreme" ? 25 : 7;
      assert.deepEqual(
        subject.initial.data.map((v) => v.id),
        Array.from({ length }, (_, i) => id(subject.index, i === 0 ? 0 : i + 1))
      );
      subject.before = await accountability(variant, subject);
    }
  }
  for (let i = 0; i < users; i++)
    assert.equal(
      variants.do.subjects[i].digest,
      variants.d1.subjects[i].digest,
      "Complete warm-up payload equivalence"
    );
  // Two equally long open-loop blocks per variant. AB then BA reverses order without co-scheduling rival runtimes.
  for (const [block, order] of [
    ["d1", "do"],
    ["do", "d1"],
  ].entries()) {
    for (const variant of order) {
      const platform = variants[variant],
        begin = performance.now() + 50;
      const pending = [];
      for (let round = 0; round < samples / 2; round++)
        for (const subject of platform.subjects) {
          const scheduled = begin + round * 1000 + subject.index * (1000 / users);
          pending.push(
            (async () => {
              await delay(Math.max(0, Math.ceil(scheduled - performance.now())));
              await observe(
                platform,
                subject,
                {
                  variant,
                  cell: "history",
                  user: subject.index,
                  sample: block * (samples / 2) + round,
                },
                scheduled,
                async (call) => {
                  const reply = await call(history);
                  assert.equal(reply.status, 200);
                  assert.deepEqual(reply.body, subject.initial);
                }
              );
            })()
          );
        }
      await Promise.all(pending);
    }
  }
  async function verifyAudit(cell, reads, corrections) {
    let ok = true;
    for (const [variant, platform] of Object.entries(variants))
      for (const subject of platform.subjects) {
        const after = await accountability(variant, subject);
        const delta = Object.fromEntries(
          Object.keys(after).map((k) => [k, after[k] - subject.before[k]])
        );
        const expected = {
          reads: reads(subject.index),
          corrections: corrections(subject.index),
          units: 0,
          receipts: 0,
        };
        record("accountability", { variant, user: subject.index, cell, delta, expected });
        ok &&= Object.keys(expected).every((k) => delta[k] === expected[k]);
        subject.before = after;
      }
    audits[cell] = ok;
    await write("audit", audits);
  }
  await verifyAudit(
    "history",
    () => samples,
    () => 0
  );
  // Both variants start each pair with identical financial state. Use a virgin Transaction for each Correction.
  for (let sample = 0; sample < samples; sample++) {
    const index = sample % users,
      ordinal = 2 + Math.floor(sample / users);
    for (const variant of sample % 2 === 0 ? ["d1", "do"] : ["do", "d1"]) {
      const platform = variants[variant],
        subject = platform.subjects[index],
        target = id(index, ordinal);
      const initial = subject.initial.data.find((v) => v.id === target);
      assert.equal(initial.revision, 0);
      const changes = { counterparty: "Referencia corregida " + ordinal };
      const corrected = { ...initial, ...changes, revision: 1 };
      const expected = {
        ...subject.initial,
        data: subject.initial.data.map((v) => (v.id === target ? corrected : v)),
      };
      await observe(
        platform,
        subject,
        { variant, cell: "correction", user: 0, financialUser: index, sample },
        performance.now(),
        async (call) => {
          const save = await call("/transactions/" + target, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedRevision: 0, changes }),
          });
          assert.equal(save.status, 200);
          assert.equal(save.body.data.id, target);
          assert.equal(save.body.data.revision, 1);
          const fresh = await call(history);
          assert.equal(fresh.status, 200);
          assert.deepEqual(fresh.body, expected);
          subject.initial = expected;
        }
      );
    }
  }
  await verifyAudit(
    "correction",
    (i) => (i < samples - users ? 2 : 1),
    (i) => (i < samples - users ? 2 : 1)
  );
}
await write("plan", {
  baseline,
  candidate: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
  environment: "disposable local workerd, GitHub-hosted Linux loopback",
  size,
  users,
  samples,
  command:
    "bun scripts/infra-performance/load/measure.mjs baseline-d1 apps/server/test-results/load extreme",
  warmup:
    "one authenticated full-history warm-up for each User and variant; actual User/shared reconstruction unobserved",
  order:
    "history: two 15-second blocks per variant, D1/DO then DO/D1, one offer/User/second at 50ms offsets; Correction: alternate variant order in 30 pairs",
  boundaries:
    "host scheduled offer and actual dispatch to the last fully buffered Miniflare loopback response body; isolated Correction includes write and fresh history",
  fixture:
    "same 100k originals, 99k effective, eight Currencies, 100 plans x 100 revisions and 5k review per User on extreme",
  criterion:
    "nearest-rank p95 D1 / DO >= 1.8 at both measured boundaries; compare complete bodies and per-User audited read/write, accounting and receipt deltas",
});
const program = Effect.gen(function* () {
  const native = yield* makeBrowserRuntime;
  const d1 = yield* Effect.acquireRelease(
    Effect.tryPromise(() => d1Platform(root)),
    (d) => Effect.promise(() => d.runtime.dispose())
  );
  yield* Effect.tryPromise(() => measure(native, d1));
});
await run(program.pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)));
