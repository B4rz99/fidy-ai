import { Schema } from "effect";

const id = Schema.String.check(Schema.isUUID());
const shared = Schema.Literals(["directory", "pricing", "maintenance", "erasure"]);
const user = { owner: Schema.Literal("user"), userId: id };
const retry = {
  action: Schema.Literal("retry-migration"),
  release: id,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3)),
  retryAtMs: Schema.Int,
  commandId: id,
};
export const StorageCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("inspect"), owner: shared }),
  Schema.Struct({ action: Schema.Literal("inspect"), ...user }),
  Schema.Struct({ ...retry, owner: shared }),
  Schema.Struct({ ...retry, ...user }),
  Schema.Struct({
    action: Schema.Literals(["inspect-work", "continue-work"]),
    ...user,
    family: Schema.Literals(["login-email", "sample"]),
    operationId: id,
  }),
  Schema.Struct({
    action: Schema.Literals(["inspect-reservation", "reconcile-reservation"]),
    owner: Schema.Literal("directory"),
    family: Schema.Literals(["bootstrap", "replacement"]),
    operationId: id,
  }),
  Schema.Struct({
    action: Schema.Literals([
      "inspect-publication",
      "reconcile-publication",
      "inspect-registration",
      "reconcile-registration",
    ]),
    owner: Schema.Literal("pricing"),
    operationId: id,
  }),
]);
export type StorageCommand = typeof StorageCommand.Type;
export const storageOperatorPath = "/internal/storage-operations";
const integer = Schema.NullOr(Schema.Int);
const watchdog = Schema.Struct({
  scheduled: Schema.Int,
  halt: Schema.Literals(["idle", "running", "wrapped", "capacity", "deadline", "cleanup"]),
  wraps: Schema.Int,
  wrapped_at: Schema.Int,
  admitted: Schema.Int,
  attempted: Schema.Int,
  observed: Schema.Int,
  failed: Schema.Int,
  unsupported: Schema.Int,
  unknown: Schema.Int,
  repaired: Schema.Int,
  coverageAgeMs: integer,
  lastAttemptMs: integer,
  lastObservedMs: integer,
  severity: Schema.Literals(["unknown", "none", "warning", "critical"]),
});
export const StoreObservation = Schema.Union([
  Schema.Struct({
    owner: Schema.Literals(["directory", "user", "maintenance", "erasure", "pricing"]),
    release: id,
    readiness: Schema.Literals([
      "ready",
      "invalid_history",
      "history_mismatch",
      "layout_mismatch",
      "attempt_refused",
      "step_failed",
      "metadata_unavailable",
    ]),
    version: integer,
    expectedVersion: Schema.Int,
    bytes: integer,
    ceilingBytes: integer,
    band: Schema.NullOr(Schema.Literals(["normal", "warning", "restricted"])),
    next: Schema.NullOr(
      Schema.Struct({
        version: Schema.Int,
        attempts: Schema.Int,
        retry_at_ms: Schema.Int,
        terminal: Schema.Int,
      })
    ),
    watchdog: Schema.optionalKey(watchdog),
  }),
  Schema.Struct({
    outcome: Schema.NullOr(
      Schema.Literals([
        "committed",
        "cancelled",
        "bound",
        "reserved",
        "started",
        "pending",
        "new",
        "approved",
        "rejected",
        "published",
        "removing",
        "withdrawn",
        "awaiting_delivery",
        "awaiting_proof",
        "sending",
        "ambiguous",
      ])
    ),
    priceId: Schema.optionalKey(id),
    deadlineMs: Schema.optionalKey(integer),
    nextCheckMs: Schema.optionalKey(integer),
    dueMs: Schema.optionalKey(integer),
    publishedAtMs: Schema.optionalKey(Schema.Int),
    selected: Schema.optionalKey(Schema.Literals([0, 1])),
  }),
]);
export const ErasureCaseCommand = Schema.Struct({
  action: Schema.Literals(["Continue", "Receipt"]),
  userId: id,
  reference: id,
});

export { ErasureOperatorReceipt } from "~/core/erasure/contract";
