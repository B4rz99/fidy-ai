import assert from "node:assert/strict";
import { correlateWorkerSpans } from "./trace.mjs";

const trace = "abcde01234567890".repeat(2);
const message = (operation, duration) =>
  '[12:00:00.000] INFO (#12): {\n  event: "span",\n  traceId: "' +
  trace +
  '",\n  data: {\n    "fidy.operation": "' +
  operation +
  '",\n  },\n  latencyMilliseconds: ' +
  duration +
  ",\n}";
const calls = [{ user: 1, sample: 3, cell: "history", traces: [trace] }];
const logs = [
  message("worker.public.fetch", 7),
  message("worker.core.fetch", 4),
  message("worker.core.alarm", 90),
  "non-span diagnostic",
];
assert.deepEqual(correlateWorkerSpans(logs, calls), [
  { user: 1, sample: 3, cell: "history", responses: [{ ingressMs: 7, coreMs: 4 }] },
]);
assert.deepEqual(
  correlateWorkerSpans([...logs, message("worker.core.fetch", 2)], calls)[0].responses,
  [{ ingressMs: 7, coreMs: null }]
);
assert.deepEqual(correlateWorkerSpans([], calls)[0].responses, [{ ingressMs: null, coreMs: null }]);
