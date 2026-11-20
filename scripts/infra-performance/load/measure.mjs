import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { makeBrowserRuntime, prepareBrowserUser } from "../../dev-browser-api";
import { signedChat } from "../../../apps/server/cloudflare/signed-whatsapp.test-fixture";
import { financialFixtureCounts, seed } from "../reference/native-seed";
import { baseline, d1Platform, origin } from "./d1.mjs";

import { inOrder, indices } from "./sequence.mjs";

const [root, directory, size = "extreme", profile = "original"] = process.argv.slice(2);
assert.ok(["extreme", "production"].includes(size));
assert.ok(["original", "native-original", "mixed-review", "single", "cpu"].includes(profile));
const nativeOnly = profile === "native-original";
assert.ok(!nativeOnly || size === "extreme", "Original native capacity requires the full fixture");
const cohortSize = 20;
const users = ["single", "cpu"].includes(profile) ? 1 : cohortSize,
  samples = 30;
const success = 200,
  badRequest = 400,
  secondMs = 1000,
  deadlineMs = 60000;
const hexRadix = 16,
  suffixWidth = 12,
  firstUser = 481,
  fullPage = 25,
  smallPage = 7;
const staleTarget = 5;
const staleBatchTargets = [4, staleTarget],
  callIdOffset = 1000000;
const history = "/transactions?limit=25";
const fixtureCurrencies = ["COP", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF"];
const minuteMs = 60_000;
const expectedHistoryRow = (user, position, currencyCount) => {
  const ordinal = position === 0 ? 0 : position + 1;
  const timestamp = new Date(Date.parse("2026-11-17T12:00:00Z") - ordinal * minuteMs).toISOString();
  const category = ordinal % 3 === 0 ? 1 : (ordinal % 15) + 2;
  return {
    id: id(user, ordinal),
    money: { amount: "1000", currency: fixtureCurrencies[ordinal % currencyCount] },
    counterparty: "Evaluación " + ordinal,
    direction: "outflow",
    categoryId: "10000000-0000-4000-8000-" + String(category).padStart(suffixWidth, "0"),
    occurredAt: timestamp,
    createdAt: timestamp,
    revision: 0,
  };
};
const write = (name, data) =>
  Bun.write(resolve(directory, name + ".json"), JSON.stringify(data, null, 2));
const record = (name, data) =>
  appendFileSync(resolve(directory, name + ".jsonl"), JSON.stringify(data) + "\n");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = (index, ordinal) =>
  "81000000-0000-4000-80" +
  index.toString(hexRadix).padStart(2, "0") +
  "-" +
  String(ordinal).padStart(suffixWidth, "0");
const run = Effect.runPromise;
const execute = ({ runtime, subject }, path, options = {}) =>
  runtime.dispatchFetch("https://api.fidyapp.com" + path, {
    ...options,
    signal: AbortSignal.timeout(deadlineMs),
    headers: {
      origin,
      "cf-connecting-ip": "192.0.2." + (subject.index + 1),
      ...subject.headers,
      ...options.headers,
    },
  });
const authenticate = async (platform, subject) => {
  const { runtime } = platform;
  const start = await execute({ runtime, subject }, "/web/pairings", { method: "POST" });
  assert.equal(start.status, success, "Browser Login pairing");
  const pair = await start.json();
  await platform.approve(subject, pair);
  const redeem = await execute({ runtime, subject }, "/web/pairings/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingId: pair.pairingId, privateVerifier: pair.privateVerifier }),
  });
  assert.equal(redeem.status, success, "Browser Login redemption");
  const cookie = redeem.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("__Host-fidy_session="));
  const response = await execute({ runtime, subject }, "/web/session/binding", {
    headers: { cookie },
  });
  assert.equal(response.status, success, "Browser Session binding");
  const { binding } = await response.json();
  assert.ok(binding);
  subject.headers = { cookie, "fidy-session-binding": binding };
};
const observe = async ({ runtime, subject }, { row, scheduled }, journey) => {
  let dispatched;
  const responses = [];
  try {
    const call = async (path, options) => {
      dispatched ??= performance.now();
      const result = await execute({ runtime, subject }, path, options);
      const bytes = new Uint8Array(await result.arrayBuffer());
      responses.push({ status: result.status, bytes, end: performance.now() });
      return { status: result.status, body: JSON.parse(new TextDecoder().decode(bytes)) };
    };
    await journey(call);
    const end = responses.at(-1).end;
    Object.assign(row, {
      ok: true,
      status: responses.at(-1).status,
      bytes: responses.reduce((total, reply) => total + reply.bytes.length, 0),
      digest: responses.map((reply) => hash(reply.bytes)).join("."),
      dispatchMs: end - dispatched,
      scheduledMs: end - scheduled,
      scheduled,
      dispatched,
      completedAt: end,
    });
  } catch (error) {
    Object.assign(row, {
      ok: false,
      status: responses.at(-1)?.status,
      error: error.name,
      scheduled,
      dispatched,
      completedAt: performance.now(),
    });
  }
  row.responses = responses.map(({ status, bytes, end }) => ({
    status,
    bytes: bytes.length,
    completedAt: end,
  }));
  record("attempts", row);
};
const accountability = async (variant, subject) => {
  const receipt = variant === "do" ? "canonical_request_receipts" : "canonical_request_replays";
  const [counts] = await subject.owner.exec(
    `SELECT
    (SELECT count(*) FROM audit_entries WHERE user_id=?1 AND operation='transactions.listTransactions' AND outcome='success') AS reads,
    (SELECT count(*) FROM audit_entries WHERE user_id=?1 AND operation='transactions.updateTransaction' AND outcome='success') AS corrections,
    (SELECT count(*) FROM audit_entries WHERE user_id=?1 AND operation='transactions.updateTransaction' AND outcome='validation_failed') AS rejectedCorrections,
    (SELECT count(*) FROM audit_entries WHERE user_id=?1 AND operation='operations.executeAtomicBatch' AND outcome='validation_failed') AS rejectedBatches,
    (SELECT COALESCE(sum(units),0) FROM commercial_allowance_consumptions WHERE user_id=?1 AND allowance='canonical_call') AS units,
    (SELECT count(*) FROM ${receipt} WHERE user_id=?1) AS receipts`,
    subject.id
  );
  return counts;
};
const platformsFor = (native, d1) => ({
  ...(d1
    ? {
        d1: {
          runtime: d1.runtime,
          subjects: [],
          approve: (subject, pair) => d1.approve(subject.id, pair),
        },
      }
    : {}),
  do: {
    runtime: native,
    subjects: [],
    approve: async (subject, pair) => {
      const response = await run(
        signedChat(
          native,
          "Aprueba el código de inicio de sesión " + pair.publicCode,
          subject.caller
        )
      );
      assert.ok(response.ok, "Signed WhatsApp approval");
    },
  },
});
const prepareFixture = async ({ native, d1, variants }, index) => {
  const user = "24000000-0000-4000-8000-" + String(firstUser + index).padStart(suffixWidth, "0");
  const caller = "CO.Load" + index;
  await inOrder(Object.entries(variants), async ([variant, platform]) => {
    process.stdout.write(`Preparing ${variant} User ${index + 1} of ${users}\n`);
    if (variant === "do") await run(prepareBrowserUser(native, user, caller));
    else await d1.prepare(user, caller);
    const owner =
      variant === "do"
        ? await native.unsafeGetDurableObjectStorage("core", "UserStore", { name: user })
        : d1.owner;
    const state = await run(
      seed(owner, size, {
        subject: user,
        index,
        d1: variant === "d1",
        mixedReview: profile === "mixed-review",
      })
    );
    const [review] = await owner.exec(
      "SELECT count(*) AS retained FROM ingestion_review_items WHERE user_id=? AND evidence_state='retained'",
      user
    );
    assert.equal(
      review.retained,
      profile === "mixed-review" ? Math.floor(state.review / cohortSize) : state.review
    );
    record("fixtures", { variant, user, index, ...state, retainedReview: review.retained });
    platform.subjects.push({
      id: user,
      index,
      caller,
      owner,
      expectedCounts: {
        transactions: state.transactions,
        currencies: state.currencies,
        effectiveTransactions: state.effectiveTransactions,
        links: state.links,
        plans: state.plans,
        revisions: state.revisions,
        review: state.review,
        retainedReview: review.retained,
      },
    });
  });
};
const warmUser = async (variant, platform, subject) => {
  await authenticate(platform, subject);
  const warm = await execute({ runtime: platform.runtime, subject }, history);
  assert.equal(warm.status, success, "Authenticated warm-up");
  const bytes = new Uint8Array(await warm.arrayBuffer());
  subject.initial = JSON.parse(new TextDecoder().decode(bytes));
  subject.digest = hash(bytes);
  const length = size === "extreme" ? fullPage : smallPage;
  assert.deepEqual(
    subject.initial.data,
    indices(length).map((position) =>
      expectedHistoryRow(subject.index, position, subject.expectedCounts.currencies)
    )
  );
  subject.before = await accountability(variant, subject);
};
const warm = async (variants) => {
  await inOrder(Object.entries(variants), ([variant, platform]) =>
    inOrder(platform.subjects, (subject) => warmUser(variant, platform, subject))
  );
  if (nativeOnly) return;
  for (const index of indices(users)) {
    assert.equal(
      variants.do.subjects[index].digest,
      variants.d1.subjects[index].digest,
      "Complete warm-up payload equivalence"
    );
  }
};
// Two equally long open-loop blocks per variant. AB then BA reverses order without co-scheduling rival runtimes.
const offerHistory = async (platform, variant, { block, begin }) => {
  const pending = indices(samples / 2).flatMap((round) =>
    platform.subjects.map(async (subject) => {
      const scheduled = begin + round * secondMs + subject.index * (secondMs / users);
      await delay(Math.max(0, Math.ceil(scheduled - performance.now())));
      const row = {
        variant,
        cell: "history",
        user: subject.index,
        sample: block * (samples / 2) + round,
      };
      await observe({ runtime: platform.runtime, subject }, { row, scheduled }, async (call) => {
        const reply = await call(history);
        assert.equal(reply.status, success);
        assert.deepEqual(reply.body, subject.initial);
      });
    })
  );
  await Promise.all(pending);
};
const offeredLoad = (variants) =>
  inOrder(
    [
      ["d1", "do"],
      ["do", "d1"],
    ]
      .entries()
      .toArray(),
    ([block, order]) =>
      inOrder(
        order.filter((variant) => variant in variants),
        (variant) =>
          offerHistory(variants[variant], variant, {
            block,
            begin: performance.now() + secondMs / users,
          })
      )
  );
const verifyAudit = async (variants, cell, { reads, corrections, rejections = () => 0 }) => {
  let ok = true;
  await inOrder(Object.entries(variants), ([variant, platform]) =>
    inOrder(platform.subjects, async (subject) => {
      const after = await accountability(variant, subject);
      const delta = Object.fromEntries(
        Object.keys(after).map((key) => [key, after[key] - subject.before[key]])
      );
      const expected = {
        reads: reads(subject.index),
        corrections: corrections(subject.index),
        rejectedCorrections: rejections(subject.index),
        rejectedBatches: rejections(subject.index),
        units: 0,
        receipts: 0,
      };
      record("accountability", { variant, user: subject.index, cell, delta, expected });
      ok &&= Object.keys(expected).every((key) => delta[key] === expected[key]);
      subject.before = after;
    })
  );
  return ok;
};
// Mutations alternate D1-first and DO-first. Each pair starts with the same confirmed target revision on both variants.
const pairedMutations = async (variants, journey) => {
  // Ordinary isolated mutations are separate from the offered read-load cell. Respect the live burst limit between pairs.
  return inOrder(indices(samples), async (sample) => {
    await delay(secondMs);
    const order = sample % 2 === 0 ? ["d1", "do"] : ["do", "d1"];
    return inOrder(
      order.filter((variant) => variant in variants),
      (variant) => {
        const platform = variants[variant],
          index = sample % users;
        return journey(
          { runtime: platform.runtime, subject: platform.subjects[index] },
          { variant, user: 0, financialUser: index, sample }
        );
      }
    );
  });
};
const correct = async ({ runtime, subject }, row) => {
  const ordinal = 2;
  const target = id(subject.index, ordinal);
  const initial = subject.initial.data.find((item) => item.id === target);
  const revision = Math.floor(row.sample / users);
  const changes = { counterparty: "Referencia corregida " + revision };
  const corrected = { ...initial, ...changes, revision: revision + 1 };
  const expected = {
    ...subject.initial,
    data: subject.initial.data.map((item) => (item.id === target ? corrected : item)),
  };
  await observe(
    { runtime, subject },
    { row: { ...row, cell: "correction" }, scheduled: performance.now() },
    async (call) => {
      assert.equal(initial.revision, revision);
      const save = await call("/transactions/" + target, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision, changes }),
      });
      assert.equal(save.status, success);
      assert.equal(save.body.data.id, target);
      assert.equal(save.body.data.revision, revision + 1);
      const fresh = await call(history);
      assert.equal(fresh.status, success);
      assert.deepEqual(fresh.body, expected);
      subject.initial = expected;
    }
  );
};
// A valid first child and a stale second child must leave both Transactions unchanged.
const rollback = async ({ runtime, subject }, row) => {
  const { sample, financialUser: index } = row;
  const calls = staleBatchTargets.map((ordinal, child) => ({
    callId: id(index, callIdOffset + sample * 2 + child),
    operation: "transactions.updateTransaction",
    input: {
      params: { id: id(index, ordinal) },
      payload: { expectedRevision: child, changes: { counterparty: "Lote rechazado" } },
    },
  }));
  await observe(
    { runtime, subject },
    { row: { ...row, cell: "rollback" }, scheduled: performance.now() },
    async (call) => {
      const refused = await call("/operations/atomic-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ calls }),
      });
      assert.equal(refused.status, badRequest);
      assert.equal(refused.body.error.failedCallIndex, 1);
      assert.equal(refused.body.error.operation, "transactions.updateTransaction");
      assert.equal(refused.body.error.code, "validation_failed");
      const fresh = await call(history);
      assert.equal(fresh.status, success);
      assert.deepEqual(fresh.body, subject.initial);
    }
  );
};
const retainedFixtures = async (variants) => {
  let verified = true;
  await inOrder(Object.entries(variants), ([variant, platform]) =>
    inOrder(platform.subjects, async (subject) => {
      const counts = await run(financialFixtureCounts(subject.owner, subject.id));
      const correct = Object.entries(subject.expectedCounts).every(
        ([key, value]) => counts[key] === value
      );
      record("retained-fixtures", {
        variant,
        user: subject.id,
        index: subject.index,
        counts,
        correct,
      });
      verified &&= correct;
    })
  );
  await write("retention", { verified });
};
const measure = async (native, d1) => {
  const variants = platformsFor(native, d1);
  await inOrder(indices(users), (index) => prepareFixture({ native, d1, variants }, index));
  await warm(variants);
  if (profile === "cpu") {
    const { profileHistory } = await import("./profile.mjs");
    await profileHistory(
      native,
      async () => {
        const subject = variants.do.subjects[0];
        const response = await execute({ runtime: native, subject }, history);
        assert.equal(response.status, success);
        assert.equal(hash(new Uint8Array(await response.arrayBuffer())), subject.digest);
      },
      write
    );
    return;
  }
  const audits = {};
  await offeredLoad(variants);
  audits.history = await verifyAudit(variants, "history", {
    reads: () => samples,
    corrections: () => 0,
  });
  await write("audit", audits);
  const perUser = (index) => Math.floor((samples - 1 - index) / users) + 1;
  await pairedMutations(variants, correct);
  audits.correction = await verifyAudit(variants, "correction", {
    reads: perUser,
    corrections: perUser,
  });
  await write("audit", audits);
  await pairedMutations(variants, rollback);
  audits.rollback = await verifyAudit(variants, "rollback", {
    reads: perUser,
    corrections: () => 0,
    rejections: perUser,
  });
  await write("audit", audits);
  await retainedFixtures(variants);
};
await write("plan", {
  baseline,
  candidate: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
  environment: "disposable local workerd, GitHub-hosted Linux loopback",
  size,
  profile,
  users,
  samples,
  command:
    "bun scripts/infra-performance/load/measure.mjs baseline-d1 apps/server/test-results/load " +
    size +
    " " +
    profile,
  warmup:
    "one authenticated full-history warm-up for each User and variant; actual User/shared reconstruction unobserved",
  order: nativeOnly
    ? "two 15-second native blocks, one offer/User/second at 50ms offsets; one-second intervals between isolated native mutations"
    : "history: two 15-second blocks per variant, D1/DO then DO/D1, one offer/User/second at (1000 / users) ms offsets; Correction and rollback: one-second interval between isolated pairs, alternate variant order in 30 pairs",
  boundaries:
    "host scheduled offer and actual dispatch to the last fully buffered Miniflare loopback response body; isolated Correction includes write and fresh history",
  fixture:
    "same 100k originals, 99k effective, eight Currencies, 100 plans x 100 revisions and 5k review per User on extreme; mixed-review uses 250 retained and 4750 expired per User",
  criterion: nativeOnly
    ? "native capacity requires all original fixture counts, read and mutation outcomes, per-User Audit and accounting; paired comparison remains missing"
    : "nearest-rank p95 D1 / DO >= 1.8 at both measured boundaries; compare complete bodies and per-User audited read/write, accounting and receipt deltas",
});
const program = Effect.gen(function* () {
  const native = yield* makeBrowserRuntime;
  if (nativeOnly) return yield* Effect.tryPromise(() => measure(native));
  const d1 = yield* Effect.acquireRelease(
    Effect.tryPromise(() => d1Platform(root)),
    (platform) => Effect.tryPromise(() => platform.runtime.dispose()).pipe(Effect.orDie)
  );
  yield* Effect.tryPromise(() => measure(native, d1));
});
await run(program.pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)));
