import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { ErasureCustodyAdmission } from "../contract";
import { validContinuation } from "./control-admission";
import { recoveryWindowMs } from "./retention-policy";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";

const acceptedStatus = 202,
  conflictStatus = 409;

const reply = (accepted: boolean): Response =>
  new Response(null, {
    status: accepted ? acceptedStatus : conflictStatus,
    headers: { "cache-control": "no-store" },
  });

export const recordNativeEvidence = Effect.fn(function* (
  request: Request,
  storage: DurableObjectStorage
) {
  const candidate = Schema.decodeUnknownOption(ErasureCustodyAdmission, {
    onExcessProperty: "error",
  })(yield* Effect.tryPromise(() => request.json()));

  if (Option.isNone(candidate)) return reply(false);
  const admission = candidate.value;
  const { userId, reference, evidence } = admission;
  const { custodian, evidenceRef, outcome } = evidence;
  const reason = outcome.status === "Unresolved" ? outcome.reason : "";
  const sql = yield* SqliteClient;

  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (
        reference !== evidence.reference ||
        !validContinuation({ admission, current: now, userId })
      ) {
        return reply(false);
      }

      const [owner] =
        yield* sql`SELECT c.status,c.event_id,r.state FROM erasure_case_custodians c JOIN erasure_cases r USING(reference) WHERE r.user_id=${userId} AND c.reference=${reference} AND c.custodian=${custodian}
        AND NOT (${outcome.status}='NotApplicable' AND (c.observed_use=1 OR c.custodian='Cloudflare'))
        AND (${outcome.status}<>'Verified' OR c.custodian<>'Cloudflare' OR (r.directory_clean=1 AND r.pricing_clean=1 AND r.last_erased_at_ms+${recoveryWindowMs}<=${now}))`;

      if (owner === undefined) return reply(false);

      if (owner.event_id === evidenceRef) {
        const replay =
          yield* sql`SELECT 1 FROM erasure_case_evidence WHERE id=${evidenceRef} AND reference=${reference} AND custodian=${custodian} AND status=${outcome.status} AND reason=${reason}`;

        return reply(replay.length === 1);
      }

      if (
        owner.state !== "ExternalPending" ||
        ["Verified", "NotApplicable"].includes(String(owner.status))
      ) {
        return reply(false);
      }

      const added =
        yield* sql`INSERT INTO erasure_case_evidence(id,reference,custodian,status,reason,operator_ref,recorded_at_ms) VALUES(${evidenceRef},${reference},${custodian},${outcome.status},${reason},${admission.authority.operatorRef},${now}) ON CONFLICT DO NOTHING RETURNING id`;

      if (added.length !== 1) return reply(false);
      yield* sql`UPDATE erasure_case_custodians SET status=${outcome.status},event_id=${evidenceRef} WHERE reference=${reference} AND custodian=${custodian}`;
      yield* sql`UPDATE erasure_cases SET next_check_ms=${now} WHERE reference=${reference}`;
      yield* preserveStoreAlarm(storage, now);

      return reply(true);
    })
  );
});
