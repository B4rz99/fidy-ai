import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { makeBrowserRuntimeWithLogs, prepareBrowserUser } from "../../dev-browser-api";
import { signedChat } from "../../../apps/server/cloudflare/signed-whatsapp.test-fixture";
import { financialFixtureCounts, seed } from "../reference/native-seed";
import { baseline, d1Platform, origin } from "./d1.mjs";

import { correlateWorkerSpans } from "./trace.mjs";
import { inOrder, indices } from "./sequence.mjs";

/** @import {Miniflare} from "miniflare" */
/** @typedef {{status:number; bytes: Uint8Array; dispatched?:number; end:number; trace:string|null}} MeasuredResponse */
/** @import {Caller, Call, Counts, D1, Journey, Mutation, Offer, Pair, Platform, Platforms, RequestOptions, SpanCall, Subject} from "./contracts.d.mts" */
const pairProof = Schema.decodeUnknownSync(
  Schema.Struct({
    pairingId: Schema.NonEmptyString,
    privateVerifier: Schema.NonEmptyString,
    publicCode: Schema.NonEmptyString,
  })
);
const bindingProof = Schema.decodeUnknownSync(Schema.Struct({ binding: Schema.NonEmptyString }));
const page = Schema.decodeUnknownSync(
  Schema.StructWithRest(
    Schema.Struct({
      data: Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({
            id: Schema.String,
            counterparty: Schema.String,
            revision: Schema.Int,
          }),
          [Schema.Record(Schema.String, Schema.Unknown)]
        )
      ),
      next: Schema.Unknown,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)]
  )
);
const correctedRecord = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Struct({ id: Schema.String, revision: Schema.Int }) })
);
const batchError = Schema.decodeUnknownSync(
  Schema.Struct({
    error: Schema.Struct({
      failedCallIndex: Schema.Int,
      operation: Schema.String,
      code: Schema.String,
    }),
  })
);
const numericCounts = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Int));
const json = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

const [root, directory, size = "extreme", profile = "original"] = process.argv.slice(2);
assert.ok(root && directory);
assert.ok(["extreme", "production"].includes(size));
assert.ok(
  ["original", "native-original", "mixed-review", "single", "two-tabs", "cpu"].includes(profile)
);
const twoTabs = profile === "two-tabs";
const nativeOnly = profile === "native-original";
assert.ok(!nativeOnly || size === "extreme", "Original native capacity requires the full fixture");
const cohortSize = 20;
const users = ["single", "two-tabs", "cpu"].includes(profile) ? 1 : cohortSize,
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
const minuteMs = 60_000,
  categoryCycle = 15;
/**
 * @param {number} user Financial User ordinal.
 * @param {number} position Visible page position.
 * @param {number} currencyCount Verified fixture currency count.
 */
const expectedHistoryRow = (user, position, currencyCount) => {
  const ordinal = position === 0 ? 0 : position + 1;
  const timestamp = new Date(Date.parse("2026-11-17T12:00:00Z") - ordinal * minuteMs).toISOString();
  const category = ordinal % 3 === 0 ? 1 : (ordinal % categoryCycle) + 2;
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
/**
 * @param {string} name Artifact or source name.
 * @param {unknown} data Evidence to persist.
 */
const write = (name, data) =>
  Bun.write(resolve(directory, name + ".json"), JSON.stringify(data, null, 2));
/**
 * @param {string} name Artifact or source name.
 * @param {unknown} data Evidence to persist.
 */
const record = (name, data) =>
  appendFileSync(resolve(directory, name + ".jsonl"), JSON.stringify(data) + "\n");
/**
 * @param {Uint8Array} bytes Complete response body.
 */
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
/**
 * @param {number} index Financial User ordinal.
 * @param {number} ordinal Transaction ordinal.
 */
const id = (index, ordinal) =>
  "81000000-0000-4000-80" +
  index.toString(hexRadix).padStart(2, "0") +
  "-" +
  String(ordinal).padStart(suffixWidth, "0");
const run = Effect.runPromise;
/** @type {{d1:string[],do:string[]} & Record<string,string[]>} */
const spanLogs = { d1: [], do: [] };
/** @type {Record<string, SpanCall[]>} */
const spanCalls = { d1: [], do: [] };
/**
 * @param {Caller} input Calling runtime and authenticated User.
 * @param {string} path Canonical request path.
 * @param {RequestOptions} options HTTP request options.
 */
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
/**
 * @param {Platform} platform Financial runtime under test.
 * @param {Subject} subject Financial User fixture.
 */
const authenticate = async (platform, subject) => {
  const { runtime } = platform;
  const start = await execute({ runtime, subject }, "/web/pairings", { method: "POST" });
  assert.equal(start.status, success, "Browser Login pairing");
  const pair = pairProof(await start.json());
  await platform.approve(subject, pair);
  const redeem = await execute({ runtime, subject }, "/web/pairings/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingId: pair.pairingId, privateVerifier: pair.privateVerifier }),
  });
  assert.equal(redeem.status, success, "Browser Login redemption");
  const cookie = redeem.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  assert.ok(cookie.startsWith("__Host-fidy_session="));
  const response = await execute({ runtime, subject }, "/web/session/binding", {
    headers: { cookie },
  });
  assert.equal(response.status, success, "Browser Session binding");
  const { binding } = bindingProof(await response.json());
  assert.ok(binding);
  subject.headers = { cookie, "fidy-session-binding": binding };
};
/**
 * @param {Caller} input Calling runtime and authenticated User.
 * @param {{row: Offer, scheduled:number}} offer Scheduled host offer.
 * @param {(call: Call)=>Promise<void>} journey Observable request journey.
 */
const observe = async ({ runtime, subject }, { row, scheduled }, journey) => {
  const timing = { dispatched: Number.NaN };
  /** @type {MeasuredResponse[]} */
  const responses = [];
  try {
    /** @type {Call} */
    const call = async (path, options) => {
      const dispatched = twoTabs ? performance.now() : undefined;
      if (Number.isNaN(timing.dispatched)) timing.dispatched = dispatched ?? performance.now();
      const result = await execute({ runtime, subject }, path, options);
      const bytes = new Uint8Array(await result.arrayBuffer());
      const end = performance.now();
      responses.push({
        status: result.status,
        bytes,
        dispatched,
        end,
        trace: result.headers.get("fidy-trace-id"),
      });
      return { status: result.status, body: json(new TextDecoder().decode(bytes)) };
    };
    await journey(call);
    const last = responses.at(-1);
    assert.ok(last);
    const dispatched = timing.dispatched;
    const end = last.end;
    Object.assign(row, {
      ok: true,
      status: last.status,
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
      status: twoTabs
        ? responses.find((reply) => reply.status !== success)?.status
        : responses.at(-1)?.status,
      error: error instanceof Error ? error.name : "UnknownError",
      scheduled,
      dispatched: Number.isNaN(timing.dispatched) ? undefined : timing.dispatched,
      completedAt: performance.now(),
    });
  }
  recordObservation(row, responses);
};
/**
 * @param {Offer} row Identified timing sample.
 * @param {MeasuredResponse[]} responses Completed response bodies.
 */
const recordObservation = (row, responses) => {
  const outcomes = responses.map(({ status, bytes, dispatched, end }) => ({
    status,
    bytes: bytes.length,
    dispatched,
    completedAt: end,
  }));
  record("attempts", { ...row, responses: outcomes });
  const calls = spanCalls[row.variant];
  assert.ok(calls);
  calls.push({
    cell: row.cell,
    user: row.user,
    sample: row.sample,
    traces: responses.map((reply) => reply.trace),
  });
};
/**
 * @param {string} variant D1 or native runtime.
 * @param {Subject} subject Financial User fixture.
 */
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
  return numericCounts(counts);
};
/**
 * @param {Miniflare} native Native workerd runtime.
 * @param {D1 | undefined} d1 Frozen D1 runtime.
 * @returns {Platforms}
 */
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
/**
 * @param {D1 | undefined} d1 Frozen D1 runtime.
 */
const platformOwner = (d1) => {
  assert.ok(d1);
  return d1.owner;
};
/**
 * @param {{native:Miniflare,d1:D1 | undefined,variants:Platforms}} context Paired fixture runtimes.
 * @param {number} index Financial User ordinal.
 */
const prepareFixture = async ({ native, d1, variants }, index) => {
  const user = "24000000-0000-4000-8000-" + String(firstUser + index).padStart(suffixWidth, "0");
  const caller = "CO.Load" + index;
  await inOrder(Object.entries(variants), async ([variant, platform]) => {
    process.stdout.write(`Preparing ${variant} User ${index + 1} of ${users}\n`);
    if (variant === "do") await run(prepareBrowserUser(native, user, caller));
    else {
      assert.ok(d1);
      await d1.prepare(user, caller);
    }
    const owner =
      variant === "do"
        ? await native.unsafeGetDurableObjectStorage("core", "UserStore", { name: user })
        : platformOwner(d1);
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
    const retainedReview = numericCounts(review).retained;
    assert.ok(typeof retainedReview === "number");
    assert.equal(
      retainedReview,
      profile === "mixed-review" ? Math.floor(state.review / cohortSize) : state.review
    );
    record("fixtures", {
      variant,
      user,
      index,
      ...state,
      retainedReview,
    });
    platform.subjects.push({
      id: user,
      index,
      caller,
      owner,
      state: { kind: "seeded" },
      headers: {},
      expectedCounts: {
        transactions: state.transactions,
        currencies: state.currencies,
        effectiveTransactions: state.effectiveTransactions,
        links: state.links,
        plans: state.plans,
        revisions: state.revisions,
        review: state.review,
        retainedReview,
      },
    });
  });
};
/**
 * @param {string} variant D1 or native runtime.
 * @param {Platform} platform Financial runtime under test.
 * @param {Subject} subject Financial User fixture.
 */
const warmUser = async (variant, platform, subject) => {
  await authenticate(platform, subject);
  const warm = await execute({ runtime: platform.runtime, subject }, history);
  assert.equal(warm.status, success, "Authenticated warm-up");
  const bytes = new Uint8Array(await warm.arrayBuffer());
  const initial = page(json(new TextDecoder().decode(bytes)));
  const length = size === "extreme" ? fullPage : smallPage;
  assert.deepEqual(
    initial.data,
    indices(length).map((position) =>
      expectedHistoryRow(subject.index, position, subject.expectedCounts.currencies)
    )
  );
  subject.state = {
    kind: "warm",
    initial,
    digest: hash(bytes),
    before: await accountability(variant, subject),
  };
};
/**
 * @param {Subject} subject Prepared financial fixture.
 */
const warmState = (subject) => {
  assert.equal(subject.state.kind, "warm");
  return subject.state;
};
/**
 * @param {Platform} platform Financial runtime.
 * @param {number} index Fixture ordinal.
 */
const subjectAt = (platform, index) => {
  const subject = platform.subjects[index];
  assert.ok(subject);
  return subject;
};
/**
 * @param {Platforms} variants Configured financial runtimes.
 */
const warm = async (variants) => {
  await inOrder(Object.entries(variants), ([variant, platform]) =>
    inOrder(platform.subjects, (subject) => warmUser(variant, platform, subject))
  );
  if (nativeOnly) return;
  assert.ok(variants.do && variants.d1);
  for (const index of indices(users)) {
    assert.equal(
      warmState(subjectAt(variants.do, index)).digest,
      warmState(subjectAt(variants.d1, index)).digest,
      "Complete warm-up payload equivalence"
    );
  }
};
// Two equally long open-loop blocks per variant. AB then BA reverses order without co-scheduling rival runtimes.
/**
 * @param {Platform} platform Financial runtime under test.
 * @param {string} variant D1 or native runtime.
 * @param {{block:number;begin:number}} schedule Declared block start and ordinal.
 */
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
        const readHistory = async () => {
          const reply = await call(history);
          assert.equal(reply.status, success);
          assert.deepEqual(reply.body, warmState(subject).initial);
        };
        if (twoTabs) {
          const pair = await Promise.allSettled([readHistory(), readHistory()]);
          for (const result of pair) {
            if (result.status === "rejected") throw result.reason;
          }
        } else await readHistory();
      });
    })
  );
  await Promise.all(pending);
};
/**
 * @param {Platforms} variants Runtimes selected for the workload.
 */
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
        (variant) => {
          const platform = variants[variant];
          assert.ok(platform);
          return offerHistory(platform, variant, {
            block,
            begin: performance.now() + secondMs / users,
          });
        }
      )
  );
/**
 * @param {Platforms} variants Runtimes selected for the workload.
 * @param {string} cell Measurement cell name.
 * @param {Counts} expected Expected per-User accountability deltas.
 */
const verifyAudit = async (variants, cell, { reads, corrections, rejections }) => {
  let ok = true;
  await inOrder(Object.entries(variants), ([variant, platform]) =>
    inOrder(platform.subjects, async (subject) => {
      const after = await accountability(variant, subject);
      const before = warmState(subject).before;
      assert.ok(before);
      const delta = Object.fromEntries(
        Object.entries(after).map(([key, value]) => {
          const prior = before[key];
          assert.ok(typeof prior === "number");
          return [key, value - prior];
        })
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
      ok &&= Object.entries(expected).every(([key, value]) => delta[key] === value);
      warmState(subject).before = after;
    })
  );
  return ok;
};
// Mutations alternate D1-first and DO-first. Each pair starts with the same confirmed target revision on both variants.
/**
 * @param {Platforms} variants Runtimes selected for the workload.
 * @param {Journey} journey Observable request journey.
 */
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
        assert.ok(platform);
        return journey(
          { runtime: platform.runtime, subject: subjectAt(platform, index) },
          { variant, user: 0, financialUser: index, sample }
        );
      }
    );
  });
};
/** @type {Journey} */
const correct = async ({ runtime, subject }, row) => {
  const ordinal = 2;
  const target = id(subject.index, ordinal);
  const original = warmState(subject).initial;
  assert.ok(original);
  const initial = original.data.find((item) => item.id === target);
  assert.ok(initial);
  const revision = Math.floor(row.sample / users);
  const changes = { counterparty: "Referencia corregida " + revision };
  const corrected = { ...initial, ...changes, revision: revision + 1 };
  const expected = {
    ...warmState(subject).initial,
    data: original.data.map((item) => (item.id === target ? corrected : item)),
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
      const changed = correctedRecord(save.body);
      assert.equal(changed.data.id, target);
      assert.equal(changed.data.revision, revision + 1);
      const fresh = await call(history);
      assert.equal(fresh.status, success);
      assert.deepEqual(fresh.body, expected);
      warmState(subject).initial = expected;
    }
  );
};
// A valid first child and a stale second child must leave both Transactions unchanged.
/** @type {Journey} */
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
      const refusal = batchError(refused.body);
      assert.equal(refusal.error.failedCallIndex, 1);
      assert.equal(refusal.error.operation, "transactions.updateTransaction");
      assert.equal(refusal.error.code, "validation_failed");
      const fresh = await call(history);
      assert.equal(fresh.status, success);
      assert.deepEqual(fresh.body, warmState(subject).initial);
    }
  );
};
/**
 * @param {Platforms} variants Runtimes selected for the workload.
 */
const retainedFixtures = async (variants) => {
  let verified = true;
  await inOrder(Object.entries(variants), ([variant, platform]) =>
    inOrder(platform.subjects, async (subject) => {
      const counts = numericCounts(await run(financialFixtureCounts(subject.owner, subject.id)));
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
/**
 * @param {Platforms} variants Runtimes selected for the workload.
 * @param {Record<string, boolean>} audits Verified Audit by timing cell.
 */
const measureMutations = async (variants, audits) => {
  /**
   * @param {number} index Financial User ordinal.
   */
  const perUser = (index) => Math.floor((samples - 1 - index) / users) + 1;
  await pairedMutations(variants, correct);
  audits.correction = await verifyAudit(variants, "correction", {
    reads: perUser,
    corrections: perUser,
    rejections: () => 0,
  });
  await write("audit", audits);
  await pairedMutations(variants, rollback);
  audits.rollback = await verifyAudit(variants, "rollback", {
    reads: perUser,
    corrections: () => 0,
    rejections: perUser,
  });
  await write("audit", audits);
};
/**
 * @param {Miniflare} native Native workerd runtime.
 * @param {D1} [d1] Frozen D1 runtime.
 */
const measure = async (native, d1) => {
  const variants = platformsFor(native, d1);
  await inOrder(indices(users), (index) => prepareFixture({ native, d1, variants }, index));
  await warm(variants);
  if (profile === "cpu") {
    const { profileHistory } = await import("./profile.mjs");
    await profileHistory(
      native,
      async () => {
        assert.ok(variants.do);
        const subject = subjectAt(variants.do, 0);
        const response = await execute({ runtime: native, subject }, history);
        assert.equal(response.status, success);
        assert.equal(hash(new Uint8Array(await response.arrayBuffer())), warmState(subject).digest);
      },
      write
    );
    return;
  }
  const audits = {};
  await offeredLoad(variants);
  audits.history = await verifyAudit(variants, "history", {
    reads: () => samples * (twoTabs ? 2 : 1),
    corrections: () => 0,
    rejections: () => 0,
  });
  await write("audit", audits);
  if (!twoTabs) await measureMutations(variants, audits);
  await retainedFixtures(variants);
  for (const variant of Object.keys(variants)) {
    const logs = spanLogs[variant],
      calls = spanCalls[variant];
    assert.ok(logs && calls);
    for (const row of correlateWorkerSpans(logs, calls)) {
      record("worker-spans", { variant, ...row });
    }
  }
};
const plannedOrder = () => {
  if (twoTabs) {
    return "two concurrent history reads on one mounted WebSession each second; two 15-second blocks per variant, D1/DO then DO/D1";
  }
  if (nativeOnly) {
    return "two 15-second native blocks, one offer/User/second at 50ms offsets; one-second intervals between isolated native mutations";
  }
  return "history: two 15-second blocks per variant, D1/DO then DO/D1, one offer/User/second at (1000 / users) ms offsets; Correction and rollback: one-second interval between isolated pairs, alternate variant order in 30 pairs";
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
    "bun scripts/infra-performance/load/measure.test-fixture.mjs baseline-d1 apps/server/test-results/load " +
    size +
    " " +
    profile,
  warmup:
    "one authenticated full-history warm-up for each User and variant; actual User/shared reconstruction unobserved",
  sameSessionConcurrency: twoTabs ? 2 : 1,
  order: plannedOrder(),
  boundaries: twoTabs
    ? "host scheduled offer and actual first dispatch through both complete responses; retain per-read dispatch and completion and verify overlap"
    : "host scheduled offer and actual dispatch to the last fully buffered Miniflare loopback response body; isolated Correction includes write and fresh history",
  fixture:
    "same 100k originals, 99k effective, eight Currencies, 100 plans x 100 revisions and 5k review per User on extreme; mixed-review uses 250 retained and 4750 expired per User",
  criterion: nativeOnly
    ? "native capacity requires all original fixture counts, read and mutation outcomes, per-User Audit and accounting; paired comparison remains missing"
    : "nearest-rank p95 D1 / DO >= 1.8 at both measured boundaries; compare complete bodies and per-User audited read/write, accounting and receipt deltas",
});
const program = Effect.gen(function* () {
  const native = yield* makeBrowserRuntimeWithLogs(spanLogs.do);
  if (nativeOnly) return yield* Effect.tryPromise(() => measure(native));
  const d1 = yield* Effect.acquireRelease(
    Effect.tryPromise(() => d1Platform(root, spanLogs.d1)),
    (platform) => Effect.tryPromise(() => platform.runtime.dispose()).pipe(Effect.orDie)
  );
  yield* Effect.tryPromise(() => measure(native, d1));
});
await run(program.pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)));
