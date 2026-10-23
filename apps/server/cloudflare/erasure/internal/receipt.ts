import { recoveryWindowMs } from "./retention-policy";
import { Effect, Schema } from "effect";
import {
  ErasureCustodian,
  ErasureCustodyEvidence,
  ErasureOperatorReceipt,
} from "../../../src/core/erasure/contract";
import {
  type ErasureScope,
  type ErasureStore,
  ErasureUnavailable,
} from "../../erasure-store/contract";

const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
const Stored = Schema.Struct({
  state: ErasureOperatorReceipt.fields.state,
  connectionBlocked: Schema.Literals([0, 1]),
  lastErasedAtMs: Schema.OptionFromNullOr(Schema.Int),
});
const StoreProgress = Schema.Struct({
  storeId: Schema.String,
  deleted: Schema.Literals([0, 1]),
});
export const receipt = (
  input: Readonly<{ db: D1Database; scope: ErasureScope; stores: ReadonlyArray<ErasureStore> }>
): Effect.Effect<typeof ErasureOperatorReceipt.Type, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { db, scope } = input;
    const rows = yield* io(() =>
      db.batch([
        db
          .prepare(
            "SELECT connection_blocked AS connectionBlocked,state,last_erased_at_ms AS lastErasedAtMs FROM erasure_requests WHERE id=? AND user_id=?"
          )
          .bind(scope.reference, scope.userId),
        db
          .prepare(`SELECT s.store_id AS storeId,s.delete_done AS deleted
      FROM erasure_steps s JOIN erasure_requests q ON q.id=s.request_id WHERE q.id=? AND q.user_id=?`)
          .bind(scope.reference, scope.userId),
        db
          .prepare(`SELECT p.custodian,p.state AS status,p.evidence_json AS evidence FROM (SELECT c.rowid,c.request_id,c.custodian,c.state,e.evidence_json FROM erasure_custody_records c LEFT JOIN erasure_custody_records e ON e.event_identity=c.current_event_id WHERE c.record_type='current') p JOIN erasure_requests q ON q.id=p.request_id
      WHERE q.id=? AND q.user_id=? ORDER BY custodian`)
          .bind(scope.reference, scope.userId),
      ])
    );
    const stored = yield* Schema.decodeUnknownEffect(Stored)(rows[0]?.results[0]);
    const progress = yield* Schema.decodeUnknownEffect(Schema.Array(StoreProgress))(
      rows[1]?.results
    );
    const custodyRows = yield* Schema.decodeUnknownEffect(Schema.Array(CustodyRow))(
      rows[2]?.results
    );
    const custodians = yield* decodeCustodians({ rows: custodyRows, reference: scope.reference });
    const completedStores = new Set(
      progress.filter((step) => step.deleted === 1).map((step) => step.storeId)
    );
    const pendingClasses = new Set(
      input.stores.filter((store) => !completedStores.has(store.id)).map((store) => store.dataClass)
    );
    const completed = [...new Set(input.stores.map((store) => store.dataClass))].filter(
      (dataClass) => !pendingClasses.has(dataClass)
    );
    const recoveryUntilMs =
      stored.lastErasedAtMs._tag === "Some" ? stored.lastErasedAtMs.value + recoveryWindowMs : null;
    return {
      reference: scope.reference,
      state: stored.state,
      completed,
      custodians,
      recoveryUntilMs,
      next: receiptNext(stored),
    };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
export const receiptNext = (
  stored: Pick<typeof Stored.Type, "state" | "connectionBlocked">
): typeof ErasureOperatorReceipt.Type.next => {
  if (stored.connectionBlocked === 1) return "connection-suppression";
  if (stored.state === "Draining") return "admitted-work";
  if (stored.state === "Complete") return "none";
  if (stored.state !== "ExternalPending") return "continue";
  return "provider-evidence";
};

const CustodyRow = Schema.Struct({
  custodian: ErasureCustodian,
  status: Schema.Literals(["Pending", "Accepted", "Verified", "NotApplicable", "Unresolved"]),
  evidence: Schema.OptionFromNullOr(Schema.fromJsonString(ErasureCustodyEvidence)),
});
const decodeCustodians = (
  input: Readonly<{ rows: ReadonlyArray<typeof CustodyRow.Type>; reference: string }>
): Effect.Effect<typeof ErasureOperatorReceipt.Type.custodians, ErasureUnavailable> =>
  Effect.forEach(input.rows, (row) =>
    Effect.gen(function* () {
      if (row.status === "Pending") return { custodian: row.custodian, status: "Pending" } as const;
      if (row.evidence._tag === "None") return yield* new ErasureUnavailable();
      const evidence = row.evidence.value;
      if (
        evidence.reference !== input.reference ||
        evidence.custodian !== row.custodian ||
        evidence.outcome.status !== row.status
      ) {
        return yield* new ErasureUnavailable();
      }
      return { custodian: row.custodian, ...evidence.outcome };
    })
  );
