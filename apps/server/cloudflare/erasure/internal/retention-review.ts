import { Clock, Effect, Option, Schema } from "effect";
import { ErasureDecision, type ErasureRetention } from "../../../src/core/erasure/contract";
import { ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureRecoveryConfiguration, ErasureRetentionAdmission } from "../contract";
import { prepareCheckpoint } from "./checkpoint";
import { RecoveryCase } from "./recovery-case";

const maximumCaseBytes = 32768;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
type Input = Readonly<{
  configuration: ErasureRecoveryConfiguration;
  admission: typeof ErasureRetentionAdmission.Type;
}>;
const Stored = Schema.Struct({
  decision: Schema.fromJsonString(ErasureDecision),
  lastErasedAtMs: Schema.OptionFromNullOr(Schema.Int),
});
const encodeDecision = Schema.encodeEffect(Schema.fromJsonString(ErasureDecision));

const validRetention = (
  previous: typeof ErasureRetention.Type,
  next: typeof ErasureRetention.Type,
  current: number
): boolean =>
  next.purpose === previous.purpose &&
  next.reviewRef !== previous.reviewRef &&
  next.reviewAtMs > current &&
  next.reviewAtMs <= next.untilMs &&
  next.untilMs >= previous.untilMs;

const reviewedDecision = (
  input: Input & Readonly<{ stored: typeof Stored.Type; current: number }>
): Option.Option<ErasureDecision> => {
  const { admission, stored, current } = input;
  const { decision } = stored;
  if (
    admission.previousReviewRef !== decision.receiptRetention.reviewRef ||
    !validRetention(decision.receiptRetention, admission.receiptRetention, current) ||
    !validRetention(decision.recovery.retention, admission.recoveryRetention, current) ||
    admission.recoveryRetention.untilMs <=
      Math.max(
        current,
        Option.getOrElse(stored.lastErasedAtMs, () => current)
      ) +
        decision.recovery.windowMs
  ) {
    return Option.none();
  }
  return Option.some({
    ...decision,
    receiptRetention: admission.receiptRetention,
    recovery: { ...decision.recovery, retention: admission.recoveryRetention },
  });
};

/** A new source-backed control review changes no financial disposition, provider outcome or backup window. Persist it independently before advancing the native generation, so a rollback cannot restore superseded control deadlines. */
export const reviewControlRetention = (input: Input): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { db } = input.configuration;
    const { admission } = input;
    const current = yield* Clock.currentTimeMillis;
    const raw = yield* io(() =>
      db
        .prepare(`SELECT decision_json AS decision,last_erased_at_ms AS lastErasedAtMs
    FROM erasure_requests WHERE id=? AND user_id=? AND decision_json IS NOT NULL`)
        .bind(admission.reference, admission.userId)
        .first()
    );
    const stored = yield* Schema.decodeUnknownEffect(Stored)(raw);
    const decision = reviewedDecision({ ...input, stored, current });
    if (Option.isNone(decision)) return false;
    const previous = yield* encodeDecision(stored.decision);
    const encoded = yield* encodeDecision(decision.value);
    yield* persistControlReview({ ...input, previous, encoded, decision: decision.value });
    const checkpoint = yield* prepareCheckpoint(input.configuration);
    const results = yield* io(() =>
      db.batch([
        ...checkpoint,
        db
          .prepare(
            "UPDATE erasure_requests SET decision_json=? WHERE id=? AND user_id=? AND decision_json=?"
          )
          .bind(encoded, admission.reference, admission.userId, previous),
        db
          .prepare(
            "SELECT EXISTS(SELECT 1 FROM erasure_requests WHERE id=? AND user_id=? AND decision_json=?) AS approved"
          )
          .bind(admission.reference, admission.userId, encoded),
      ])
    );
    const result = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ approved: Schema.Literals([0, 1]) })
    )(results.at(-1)?.results[0]);
    return result.approved === 1;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const persistControlReview = (
  input: Input & Readonly<{ previous: string; encoded: string; decision: ErasureDecision }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { bucket } = input.configuration;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const key = `recovery/cases/${input.admission.reference}`;
    const { record, etag } = yield* readControlCase(bucket.value, key);
    const previous = yield* encodeDecision(record.decision);
    if (previous !== input.previous && previous !== input.encoded) {
      return yield* new ErasureUnavailable();
    }
    const current = yield* Clock.currentTimeMillis;
    if (input.admission.deadlineMs <= current || input.admission.authority.expiresAtMs <= current) {
      return yield* new ErasureUnavailable();
    }
    if (previous === input.encoded) return;
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryCase))({
      ...record,
      decision: input.decision,
    });
    const updated = yield* io(() => bucket.value.put(key, body, { onlyIf: { etagMatches: etag } }));
    if (updated === null) return yield* new ErasureUnavailable();
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const readControlCase = (
  bucket: R2Bucket,
  key: string
): Effect.Effect<
  Readonly<{ record: typeof RecoveryCase.Type; etag: string }>,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    const object = yield* io(() => bucket.get(key));
    if (object === null) return yield* new ErasureUnavailable();
    if (object.size > maximumCaseBytes) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    const record = yield* Schema.decodeEffect(Schema.fromJsonString(RecoveryCase))(
      yield* io(() => object.text())
    );
    return { record, etag: object.etag };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
