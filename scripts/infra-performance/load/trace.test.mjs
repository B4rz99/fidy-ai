import assert from "node:assert/strict";
import { correlateWorkerSpans } from "./trace.mjs";

const trace = "abcde01234567890".repeat(2);
/**
 * @param {string} operation Observed Worker operation.
 * @param {number} duration Elapsed time in milliseconds.
 */
const message = (operation, duration) =>
  '[12:00:00.000] INFO (#12): {\n  event: "span",\n  traceId: "' +
  trace +
  '",\n  data: {\n    "fidy.operation": "' +
  operation +
  '",\n  },\n  latencyMilliseconds: ' +
  duration +
  ",\n}";
const calls = [{ user: 1, sample: 3, cell: "history", traces: [trace] }];
const ingressMs = 7,
  backgroundMs = 90;
const logs = [
  message("worker.public.fetch", ingressMs),
  message("worker.core.fetch", 4),
  message("worker.core.alarm", backgroundMs),
  "non-span diagnostic",
];
assert.deepEqual(correlateWorkerSpans(logs, calls), [
  { user: 1, sample: 3, cell: "history", responses: [{ ingressMs: 7, coreMs: 4 }] },
]);
assert.deepEqual(
  correlateWorkerSpans([...logs, message("worker.core.fetch", 2)], calls).at(0)?.responses,
  [{ ingressMs: 7, coreMs: null }]
);
assert.deepEqual(correlateWorkerSpans([], calls).at(0)?.responses, [
  { ingressMs: null, coreMs: null },
]);

assert.deepEqual(correlateWorkerSpans(logs, calls, true).at(0)?.responses, [
  { ingressMs: 7, coreMs: 4, ingressFinishedClockMs: 43_200_000, canonicalHistoryMs: null },
]);
assert.deepEqual(
  correlateWorkerSpans([...logs, message("worker.public.fetch", 3)], calls, true).at(0)?.responses,
  [{ ingressMs: null, coreMs: 4, ingressFinishedClockMs: null, canonicalHistoryMs: null }]
);

const coreId = "0".repeat(16);
const core = message("worker.core.fetch", 4).replace("  data:", `  spanId: "${coreId}",\n  data:`);
const canonical = message("transactions.listTransactions", 3).replace(
  "  data:",
  `  parentSpanId: "${coreId}",\n  data:`
);
assert.equal(
  correlateWorkerSpans([logs[0], core, canonical], calls, true).at(0)?.responses[0]
    .canonicalHistoryMs,
  3
);
assert.equal(
  correlateWorkerSpans([logs[0], core, canonical.replace(coreId, "1".repeat(16))], calls, true).at(
    0
  )?.responses[0].canonicalHistoryMs,
  null
);
