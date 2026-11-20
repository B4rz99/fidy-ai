// Keep V8 sampling outside acceptance runs. Only aggregate code-frame counts leave the runner.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Option, Schema } from "effect";
import { profileWorkerRequest } from "../../document-parsing/workerd-inspector";
import { inOrder, indices } from "./sequence.mjs";

const maxFrames = 48,
  batches = 25,
  readsPerBatch = 4,
  interBatchMs = 500;
/** @typedef {Parameters<NonNullable<Parameters<typeof profileWorkerRequest>[1]>>[0]} Profile */
/** @typedef {Map<string,number>} Frames */
/** @typedef {{leaf:Frames, inclusive:Frames}} Counts */
const targetsFrom = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      webSocketDebuggerUrl: Schema.String,
    })
  )
);
/**
 * @param {Frames} totals Accumulated sample counts.
 * @param {string} frame Named CPU profile frame.
 */
const increment = (totals, frame) => totals.set(frame, (totals.get(frame) ?? 0) + 1);
/**
 * @param {Map<number, Profile["nodes"][number]>} byId Profile nodes by identifier.
 * @param {number} id Profile node identifier.
 */
const frameName = (byId, id) => {
  const name = byId.get(id)?.callFrame.functionName ?? "";
  return name.length > 0 ? name : "<anonymous>";
};
/**
 * @param {Profile} profile V8 CPU sample.
 * @param {Counts} totals Accumulated sample counts.
 */
const accumulate = ({ nodes, samples }, { leaf, inclusive }) => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parents = new Map(
    nodes.flatMap((node) => (node.children ?? []).map((child) => [child, node.id]))
  );
  for (const id of samples) {
    const frame = frameName(byId, id);
    if (frame === "(idle)") continue;
    increment(leaf, frame);
    /** @type {Set<string>} */
    const stack = new Set();
    for (
      let cursor = /** @type {number | undefined} */ (id);
      cursor !== undefined;
      cursor = parents.get(cursor)
    ) {
      stack.add(frameName(byId, cursor));
    }
    for (const parent of stack) increment(inclusive, parent);
  }
};
/**
 * @param {Frames} entries Observed frame counts.
 */
const top = (entries) =>
  Array.from(entries)
    .sort((left, right) => right[1] - left[1])
    .slice(0, maxFrames);
/**
 * *
 * @param {import("miniflare").Miniflare} runtime Worker runtime under test.
 * @param {()=>Promise<void>} read Full authenticated history read.
 * @param {(name:string,data:unknown)=>Promise<unknown>} write Diagnostic artifact writer.
 */
export const profileHistory = async (runtime, read, write) => {
  const url = await runtime.getInspectorURL();
  const targets = targetsFrom(
    await (await fetch("http://127.0.0.1:" + url.port + "/json/list")).json()
  );
  await write(
    "profile-targets",
    targets.map(({ id, title }) => ({ id, title }))
  );
  const production = targets.filter((target) => /(?:^|[:/])(core|ingress)$/.test(target.id));
  assert.equal(production.length, 2);
  await inOrder(production, async (target) => {
    const address = new URL(target.webSocketDebuggerUrl);
    assert.equal(address.hostname, "127.0.0.1");
    /** @type {Counts} */
    const counts = { leaf: new Map(), inclusive: new Map() };
    await inOrder(indices(batches), async () => {
      // Keep the rate-limit interval completely outside the sampled interval.
      await delay(interBatchMs);
      await profileWorkerRequest(
        {
          debuggerUrl: address.href,
          signal: Option.none(),
          sendRequest: async () => {
            await inOrder(indices(readsPerBatch), read);
            return new Response();
          },
        },
        (profile) => accumulate(profile, counts)
      );
    });
    await write("profile-" + target.id.split(/[:/]/).at(-1), {
      reads: batches * readsPerBatch,
      leafSamples: top(counts.leaf),
      inclusiveSamples: top(counts.inclusive),
    });
  });
};
