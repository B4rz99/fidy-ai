import { Clock, Effect, Option, Schema } from "effect";
import { recoveryWindowMs } from "./retention-policy";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { ErasureCustodyAdmission } from "../contract";
import { requireInventory } from "./inventory";
import { validContinuation } from "./control-admission";
import type { ErasureStore } from "../../erasure-store/contract";

const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });

/** Recorded confirms the current projection; Conflict may retain a rejected event. */
export const submitCustodyEvidence = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    candidate: unknown;
    stores: ReadonlyArray<ErasureStore>;
  }>
): Effect.Effect<"Recorded" | "Conflict", ErasureUnavailable> =>
  Effect.gen(function* () {
    const decoded = Schema.decodeUnknownOption(ErasureCustodyAdmission, {
      onExcessProperty: "error",
    })(input.candidate);
    const current = yield* Clock.currentTimeMillis;
    if (
      Option.isNone(decoded) ||
      !validContinuation({ admission: decoded.value, current, userId: input.userId }) ||
      decoded.value.reference !== decoded.value.evidence.reference
    ) {
      return "Conflict";
    }
    const admission = decoded.value;
    yield* requireInventory({
      db: input.db,
      scope: { reference: admission.reference, userId: input.userId },
      stores: input.stores,
    });
    return (yield* recordCustodyEvidence({ db: input.db, admission, current }))
      ? "Recorded"
      : "Conflict";
  });

const validOutcome = (
  input: Readonly<{
    admission: typeof ErasureCustodyAdmission.Type;
    lastErasedAtMs: number;
    current: number;
  }>
): boolean => {
  const { evidence } = input.admission;
  if (invalidApplicability(evidence)) return false;
  if (evidence.custodian === "Cloudflare" && evidence.outcome.status === "Verified") {
    return input.lastErasedAtMs + recoveryWindowMs <= input.current;
  }
  return true;
};
const persistEvidence = (
  input: Readonly<{
    db: D1Database;
    admission: typeof ErasureCustodyAdmission.Type;
    current: number;
    encoded: string;
  }>
): Effect.Effect<ReadonlyArray<D1Result>, ErasureUnavailable> => {
  const { db, admission, current, encoded } = input;
  return io(() =>
    db.batch([
      db
        .prepare(`INSERT INTO erasure_custody_records(record_type,id,request_id,custodian,evidence_json,recorded_at_ms,operator_ref)
      VALUES('event',?,?,?,?,?,?) ON CONFLICT(event_identity) DO NOTHING`)
        .bind(
          admission.evidence.evidenceRef,
          admission.reference,
          admission.evidence.custodian,
          encoded,
          current,
          admission.authority.operatorRef
        ),
      db
        .prepare(`UPDATE erasure_custody_records SET state=?,current_event_id=? WHERE record_type='current' AND request_id=? AND custodian=?
      AND EXISTS(SELECT 1 FROM (SELECT rowid,id,request_id,custodian,evidence_json,recorded_at_ms,operator_ref FROM erasure_custody_records WHERE record_type='event') WHERE id=? AND request_id=? AND evidence_json=?
        AND (erasure_custody_records.custodian<>'Cloudflare' OR recorded_at_ms>=(SELECT last_erased_at_ms FROM erasure_requests WHERE id=erasure_custody_records.request_id)))
      AND (state NOT IN('Verified','NotApplicable') OR current_event_id=?)`)
        .bind(
          admission.evidence.outcome.status,
          admission.evidence.evidenceRef,
          admission.reference,
          admission.evidence.custodian,
          admission.evidence.evidenceRef,
          admission.reference,
          encoded,
          admission.evidence.evidenceRef
        ),
      db
        .prepare(
          `SELECT EXISTS(SELECT 1 FROM (SELECT c.rowid,c.request_id,c.custodian,c.state,e.evidence_json FROM erasure_custody_records c LEFT JOIN erasure_custody_records e ON e.event_identity=c.current_event_id WHERE c.record_type='current') WHERE request_id=? AND custodian=? AND evidence_json=?) AS recorded`
        )
        .bind(admission.reference, admission.evidence.custodian, encoded),
    ])
  );
};

const recordCustodyEvidence = (
  input: Readonly<{
    db: D1Database;
    admission: typeof ErasureCustodyAdmission.Type;
    current: number;
  }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { admission, db, current } = input;
    const raw = yield* io(() =>
      db
        .prepare(`SELECT last_erased_at_ms AS lastErasedAtMs
    FROM erasure_requests WHERE id=? AND user_id=? AND state='ExternalPending'`)
        .bind(admission.reference, admission.userId)
        .first()
    );
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        lastErasedAtMs: Schema.Int,
      })
    )(raw);
    if (!validOutcome({ ...input, ...row, current })) return false;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      admission.evidence
    );
    const results = yield* persistEvidence({ ...input, current, encoded });
    const result = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ recorded: Schema.Literals([0, 1]) })
    )(results.at(-1)?.results[0]);
    return result.recorded === 1;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const invalidApplicability = (evidence: typeof ErasureCustodyAdmission.Type.evidence): boolean =>
  evidence.outcome.status === "NotApplicable" && evidence.custodian === "Cloudflare";
