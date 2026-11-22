import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { parseAck, parseHistory, parseRefusal } from "./contracts";

const success = 200,
  invalid = 400;

/** @param {unknown} value Verified JSON. */
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** @param {Response} response Canonical result. @param {number} status Expected HTTP status. @returns {Promise<unknown>} */
const completed = async (response, status) => {
  assert.equal(response.status, status, "Unexpected scoped mutation status");
  /** @type {unknown} */
  const payload = await response.json();

  return payload;
};

/** @param {string} notes New synthetic notes. */
const change = (notes) => ({ expectedRevision: 0, changes: { notes } });

/** @param {unknown} captured Verified effective history.
 * @param {(method:string,path:string,body?:unknown)=>Promise<Response>} send Original, bound WebSession transport. */
export const proveScopedCorrection = async (captured, send) => {
  const before = parseHistory(captured);
  const target = before.data.find((row) => row.counterparty === "Evaluación 2");
  const untouched = before.data.find((row) => row.counterparty === "Evaluación 3");
  assert.ok(target && untouched && target.revision === 0 && untouched.revision === 0);
  const notes = "Nota sintética corregida";

  const after = {
    ...before,
    data: before.data.map((row) => (row.id === target.id ? { ...row, notes, revision: 1 } : row)),
  };

  const result = parseAck(
    await completed(await send("PUT", "/transactions/" + target.id, change(notes)), success)
  );

  assert.equal(result.data.id, target.id);
  assert.equal(result.data.revision, 1);
  const read = async () => completed(await send("GET", "/transactions?limit=25"), success);
  const committed = await read();
  assert.deepEqual(committed, after);

  const calls = [untouched, target].map((row, index) => ({
    callId: "99000000-0000-4000-8000-00000000000" + (index + 1),
    operation: "transactions.updateTransaction",
    input: { params: { id: row.id }, payload: change("No debe persistir") },
  }));

  const refusal = parseRefusal(
    await completed(await send("POST", "/operations/atomic-batch", { calls }), invalid)
  );

  assert.equal(refusal.error.failedCallIndex, 1);
  assert.equal(refusal.error.operation, "transactions.updateTransaction");
  assert.equal(refusal.error.code, "validation_failed");
  const rolledBack = await read();
  assert.deepEqual(rolledBack, after);

  return {
    before: hash(before),
    committed: hash(committed),
    afterRollback: hash(rolledBack),
    failedCallIndex: 1,
    committedCorrections: 1,
  };
};
