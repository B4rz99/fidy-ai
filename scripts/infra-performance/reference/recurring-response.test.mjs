import assert from "node:assert/strict";
import { responseEvidence } from "./fresh-recurring.mjs";

// The frozen D1 instrumentation times /transactions only. Chromium measures Recurring transport.
const body = Buffer.from('{"data":{}}');
const chunkFraming = 14,
  timing = 13,
  headerBytes = 300,
  ok = 200;
const reply = {
  body: async () => body,
  request: () => ({
    sizes: async () => ({
      responseBodySize: body.length + chunkFraming,
      responseHeadersSize: headerBytes,
    }),
    timing: () => ({ responseEnd: timing }),
  }),
  status: () => ok,
  allHeaders: async () => ({}),
};
const events = [];
const http = await responseEvidence(
  { event: (row) => events.push(row) },
  "recurring.full.http",
  reply
);
assert.equal(http.httpMs, timing);
assert.equal(http.bytes, body.length);
assert.equal(http.wireBodyBytes, body.length + chunkFraming);
assert.equal(events.length, 1);
