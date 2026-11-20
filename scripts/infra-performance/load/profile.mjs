// Keep V8 CPU sampling in a separate diagnostic run. Only aggregate synthetic code frames leave the runner.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Option } from "effect";
import { profileWorkerRequest } from "../../document-parsing/workerd-inspector";
import { inOrder, indices } from "./sequence.mjs";

const maxFrames = 48,
  sampleReads = 100,
  intervalMs = 125;
const addTime = (totals, name, elapsed) => totals.set(name, (totals.get(name) ?? 0) + elapsed);
const frameName = (byId, id) => byId.get(id)?.callFrame.functionName || "<anonymous>";
const summarize = ({ nodes, samples, timeDeltas }) => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parents = new Map(
    nodes.flatMap((node) => (node.children ?? []).map((child) => [child, node.id]))
  );
  const cumulative = new Map(),
    leaf = new Map();
  for (const [index, id] of samples.entries()) {
    const name = frameName(byId, id);
    if (name === "(idle)") continue;
    const elapsed = timeDeltas[index];
    addTime(leaf, name, elapsed);
    const stack = new Set();
    for (let cursor = id; cursor !== undefined; cursor = parents.get(cursor)) {
      stack.add(frameName(byId, cursor));
    }
    for (const frame of stack) addTime(cumulative, frame, elapsed);
  }
  const top = (entries) =>
    Array.from(entries)
      .sort((left, right) => right[1] - left[1])
      .slice(0, maxFrames);
  return {
    samples: samples.length,
    leafMicroseconds: top(leaf),
    inclusiveMicroseconds: top(cumulative),
  };
};
export const profileHistory = async (runtime, read, write) => {
  const url = await runtime.getInspectorURL();
  const targets = await (await fetch("http://127.0.0.1:" + url.port + "/json/list")).json();
  await write(
    "profile-targets",
    targets.map(({ id, title }) => ({ id, title }))
  );
  const production = targets.filter((target) => /(?:^|[:/])(core|ingress)$/.test(target.id));
  assert.equal(production.length, 2);
  await inOrder(production, async (target) => {
    const address = new URL(target.webSocketDebuggerUrl);
    assert.equal(address.hostname, "127.0.0.1");
    let summary;
    const result = await profileWorkerRequest(
      {
        debuggerUrl: address.href,
        signal: Option.none(),
        sendRequest: async () => {
          await inOrder(indices(sampleReads), async () => {
            await delay(intervalMs);
            await read();
          });
          return new Response();
        },
      },
      (profile) => {
        summary = summarize(profile);
      }
    );
    await write("profile-" + target.id.split(/[:/]/).at(-1), {
      reads: sampleReads,
      ms: result.cpuMilliseconds,
      ...summary,
    });
  });
};
