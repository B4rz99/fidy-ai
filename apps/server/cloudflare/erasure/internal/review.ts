import type { RecoveryCase } from "./recovery-case";
import { persistReviewedCase } from "./checkpoint";
import type { ErasureRecoveryConfiguration, ErasureReviewAdmission } from "../contract";
import { Clock, Effect, Option, Schema } from "effect";
import type { ErasureDecision, ErasureRetention } from "../../../src/core/erasure/contract";
import { ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureStore } from "../../erasure-store/contract";

const admissionLifetimeMs = 5000;
const validRetention = (retention: typeof ErasureRetention.Type, current: number): boolean =>
  retention.reviewAtMs > current && retention.reviewAtMs <= retention.untilMs;
const validDecision = (decision: ErasureDecision, current: number): boolean =>
  decision.dispositions.identity.action === "Delete" &&
  decision.dispositions.credentials.action === "Delete" &&
  validRetention(decision.receiptRetention, current) &&
  decision.receiptRetention.purpose === "rights-response" &&
  decision.recovery.retention.purpose === "restore-enforcement" &&
  validRetention(decision.recovery.retention, current) &&
  current + decision.recovery.windowMs < decision.recovery.retention.untilMs &&
  Object.values(decision.dispositions).every((disposition) => disposition.action === "Delete");

type ReviewInput = Readonly<{
  db: D1Database;
  admission: ErasureReviewAdmission;
  stores: ReadonlyArray<ErasureStore>;
  recovery: ErasureRecoveryConfiguration;
}>;
export const review = (input: ReviewInput): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const { admission, db } = input;
    const { decision } = admission;
    if (!validAdmission({ admission, current })) return false;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(decision);
    const intent = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(
            "SELECT requested_at_ms AS requestedAtMs,decision_json AS decision FROM erasure_requests WHERE id=? AND user_id=?"
          )
          .bind(decision.reference, admission.userId)
          .first(),
      catch: () => new ErasureUnavailable(),
    }).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.OptionFromNullOr(
            Schema.Struct({
              requestedAtMs: Schema.Int,
              decision: Schema.OptionFromNullOr(Schema.String),
            })
          )
        )
      )
    );
    if (Option.isNone(intent)) return false;
    if (Option.isSome(intent.value.decision)) return intent.value.decision.value === encoded;
    const publication = yield* persistReviewedCase({
      configuration: input.recovery,
      record: {
        decision,
        sealed: false,
        requestedAtMs: intent.value.requestedAtMs,
        reviewedAtMs: current,
        operatorRef: admission.authority.operatorRef,
      },
    });
    const results = yield* commitReview({ ...input, encoded, ...publication });
    const result = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ approved: Schema.Literals([0, 1]) })
    )(results.at(-1)?.results[0]);
    return result.approved === 1;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const commitReview = (
  input: ReviewInput &
    Readonly<{
      encoded: string;
      record: typeof RecoveryCase.Type;
      checkpoint: ReadonlyArray<D1PreparedStatement>;
    }>
): Effect.Effect<ReadonlyArray<D1Result>, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { db, admission, encoded, record } = input;
    const { decision } = admission;
    const inventory = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      input.stores.map(({ id, dataClass }) => ({ id, dataClass }))
    );
    return yield* Effect.uninterruptible(
      Effect.tryPromise({
        try: () =>
          db.batch([
            ...input.checkpoint,
            db
              .prepare(`UPDATE erasure_requests SET case_ref=?,scope_ref=?,authority_ref=?,decision_json=?,reviewed_at_ms=?,operator_ref=?,state='Draining'
        WHERE id=? AND user_id=? AND state='AwaitingReview'`)
              .bind(
                decision.caseRef,
                decision.scopeRef,
                decision.authorityRef,
                encoded,
                record.reviewedAtMs,
                admission.authority.operatorRef,
                decision.reference,
                admission.userId
              ),
            db
              .prepare(`INSERT INTO erasure_steps(request_id,store_id,data_class)
              SELECT q.id,json_extract(s.value,'$.id'),json_extract(s.value,'$.dataClass')
              FROM erasure_requests q,json_each(?) s WHERE q.id=? AND q.user_id=? AND q.decision_json=?
              ON CONFLICT(request_id,store_id) DO NOTHING`)
              .bind(inventory, decision.reference, admission.userId, encoded),
            db
              .prepare(`INSERT INTO erasure_custody_records(record_type,request_id,custodian,state)
              SELECT 'current',q.id,p.value,'Pending' FROM erasure_requests q,json_each('["Cloudflare","Kapso","Meta","Resend","Wompi","SupportInbox","CaseRegister","CaseEvidence"]') p
              WHERE q.id=? AND q.user_id=? AND q.decision_json=? ON CONFLICT(request_id,custodian) WHERE record_type='current' DO NOTHING`)
              .bind(decision.reference, admission.userId, encoded),
            db
              .prepare(
                `SELECT EXISTS(SELECT 1 FROM erasure_requests WHERE id=? AND user_id=? AND decision_json=?) AS approved`
              )
              .bind(decision.reference, admission.userId, encoded),
          ]),
        catch: () => new ErasureUnavailable(),
      })
    );
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const validAdmission = (
  input: Readonly<{ admission: ErasureReviewAdmission; current: number }>
): boolean =>
  input.admission.userId === input.admission.decision.userId &&
  input.admission.deadlineMs > input.current &&
  input.admission.deadlineMs <= input.current + admissionLifetimeMs &&
  input.admission.authority.expiresAtMs > input.current &&
  validDecision(input.admission.decision, input.current);
