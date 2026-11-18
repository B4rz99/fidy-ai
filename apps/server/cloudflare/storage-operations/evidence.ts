import { withStoreCapacity } from "../runtime/sqlite/operations";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect } from "effect";
import type { StorageCommand } from "./contract";

const okStatus = 200;
const conflictStatus = 409;
const missingStatus = 404;
const timestampWidth = 15;
const dayMs = 86400000;
const retentionDays = 365;

const retentionMs = retentionDays * dayMs;
const pageSize = 32;
type Evidence = Readonly<{
  issuer: string;
  operator: string;
  action: string;
  target: string;
  time: number;
  outcome: string;
}>;
const evidenceOwners = {
  bootstrap: ["provider_attempts", "pairing_id"],
  replacement: ["identity_replacements", "id"],
  sample: ["ingest_sample_decisions", "candidate_id"],
  "login-email": ["login_email_proofs", "work_id"],
  publication: ["price_publications", "id"],
  registration: ["price_registrations", "operation_id"],
} as const;
const recordFamily = (
  cmd: Extract<StorageCommand, { operationId: string }>
): keyof typeof evidenceOwners => {
  if ("family" in cmd) return cmd.family;
  return cmd.action.endsWith("publication") ? "publication" : "registration";
};
const claimTarget = Effect.fnUntraced(function* (
  cmd: Extract<StorageCommand, { operationId: string }>,
  key: string,
  evidence: Evidence
) {
  const sql = yield* SqliteClient;
  const [table, column] = evidenceOwners[recordFamily(cmd)];
  // Existence and attribution commit in one owner-local statement. Erasure deletes evidence with its original row.
  const rows =
    yield* sql`INSERT INTO storage_operation_evidence SELECT ${key},${evidence.issuer},${evidence.operator},${evidence.action},${recordFamily(cmd)},${cmd.operationId},${evidence.time},'unknown'
    WHERE EXISTS(SELECT 1 FROM ${sql(table)} WHERE ${sql(column)}=${cmd.operationId}) RETURNING id`;
  return rows.length === 1;
});
const receiptPrefix = "storage-operation:";
const expiryPrefix = "storage-operation-expiry:";
const ordered = (timestamp: number): string => String(timestamp).padStart(timestampWidth, "0");
export const forgetExpiredReceipts = ({
  storage,
  now,
}: {
  storage: DurableObjectStorage;
  now: number;
}): void => {
  const cutoff = expiryPrefix + ordered(now - retentionMs);
  storage.transactionSync(() => {
    for (const [expired, key] of storage.kv.list<string>({
      start: expiryPrefix,
      end: cutoff,
      limit: pageSize,
    })) {
      storage.kv.delete(expired);
      storage.kv.delete(key);
    }
  });
};
export const expireTargetEvidence = Effect.fnUntraced(function* (now: number) {
  const sql = yield* SqliteClient;
  yield* sql`DELETE FROM storage_operation_evidence WHERE id IN (SELECT id FROM storage_operation_evidence WHERE occurred_ms<${now - retentionMs} ORDER BY occurred_ms LIMIT ${pageSize})`;
});
type StoredOperation = Readonly<{
  cmd: StorageCommand;
  storage: DurableObjectStorage;
  key: string;
  evidence: Evidence;
}>;
export const claimOperationEvidence = Effect.fnUntraced(function* ({
  cmd,
  storage,
  key,
  evidence,
}: StoredOperation) {
  if ("operationId" in cmd) {
    return (yield* withStoreCapacity("required")(claimTarget(cmd, key, evidence)))
      ? okStatus
      : missingStatus;
  }
  return yield* Effect.try(() =>
    storage.transactionSync(() => {
      const receipt = receiptPrefix + key;
      if (storage.kv.get(receipt) !== undefined) return conflictStatus;
      storage.kv.put(receipt, evidence);
      storage.kv.put(expiryPrefix + ordered(evidence.time) + ":" + key, receipt);
      return okStatus;
    })
  );
});
export const finishOperationEvidence = Effect.fnUntraced(function* ({
  cmd,
  storage,
  key,
  evidence,
}: StoredOperation) {
  if ("operationId" in cmd) {
    const sql = yield* SqliteClient;
    yield* withStoreCapacity("required")(
      sql`UPDATE storage_operation_evidence SET outcome=${evidence.outcome} WHERE id=${key}`
    );
    return;
  }
  yield* Effect.try(() =>
    storage.transactionSync(() => {
      const receipt = receiptPrefix + key;
      if (storage.kv.get(receipt) !== undefined) storage.kv.put(receipt, evidence);
    })
  );
});
