/// <reference types="bun-types" />

import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { withReviewPressureSnapshot } from "./native-review-pressure";

const db = new Database(":memory:");

db.exec("CREATE TABLE canonical_request_buckets(subject TEXT, virtual_at_ms INTEGER)");

db.exec("CREATE TABLE canonical_request_leases(user_id TEXT, expires_at_ms INTEGER)");

/**
 * @param {string} sql Query used by the native owner observer.
 * @param {...(string | number)} params Bound values for the disposable SQLite database.
 * @returns {Promise<unknown[]>} Rows decoded by the observer.
 */
const queryRows = async (sql, ...params) => {
  /** @type {unknown[]} */
  const rows = db.query(sql).all(...params);

  return rows;
};

const owner = { exec: queryRows };

const user = "fixture";

const request = new Request("https://127.0.0.1/ingestion/review-workspace/context?status=pending");

const header = "x-reference-review-pressure";

/** @param {number} status HTTP status observed by the loopback runner. */
const observe = (status) =>
  Effect.runPromise(
    withReviewPressureSnapshot({
      owner,
      user,
      request,
      response: new Response("first response", { status, headers: { "retry-after": "1" } }),
    })
  );

const leaseMs = 60000,
  tooManyRequests = 429,
  success = 200;

const future = Date.now() + leaseMs;

db.query("INSERT INTO canonical_request_leases VALUES(?, ?), (?, ?), (?, ?)").run(
  "other",
  future,
  "other",
  future,
  user,
  0
);

assert.equal((await observe(tooManyRequests)).headers.get(header), "neither");

db.query("INSERT INTO canonical_request_buckets VALUES(?, ?)").run("user:" + user, future);

assert.equal((await observe(tooManyRequests)).headers.get(header), "bucket");

db.query("INSERT INTO canonical_request_leases VALUES(?, ?), (?, ?)").run(
  user,
  future,
  user,
  future
);

assert.equal((await observe(tooManyRequests)).headers.get(header), "both");

db.exec("DELETE FROM canonical_request_buckets");

const refused = await observe(tooManyRequests);

assert.equal(refused.headers.get(header), "leases");

assert.equal(refused.status, tooManyRequests);

assert.equal(refused.headers.get("retry-after"), "1");

assert.equal(await refused.text(), "first response");

db.close();

assert.equal((await observe(success)).headers.get(header), null);

const unobserved = await observe(tooManyRequests);

assert.equal(unobserved.status, tooManyRequests);

assert.equal(unobserved.headers.get(header), null);
