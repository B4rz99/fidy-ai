import assert from "node:assert/strict";
import { Schema } from "effect";
import { prepareReferenceDashboard } from "../reference/fresh-dashboard.mjs";
import { prepareReferenceRecurring } from "../reference/fresh-recurring.mjs";

const input = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      origin: Schema.Literals(["https://127.0.0.1:4183", "https://127.0.0.1:4173"]),
      binding: Schema.NonEmptyString,
      cookie: Schema.NonEmptyString,
    })
  )
)(await Bun.stdin.text());
const api = new URL(input.origin);
api.port = String(Number(api.port) + 1);
assert.equal(api.hostname, "127.0.0.1");
const { request } = await import("@playwright/test");
const client = await request.newContext({ ignoreHTTPSErrors: true, maxRedirects: 0 });
const installation = {
  api: api.origin,
  headers: { origin: input.origin, cookie: input.cookie, "fidy-session-binding": input.binding },
};
try {
  await prepareReferenceDashboard(client, installation);
  await prepareReferenceRecurring(client, installation);
} finally {
  await client.dispose();
}
