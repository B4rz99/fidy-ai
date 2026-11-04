import { Effect, Schema } from "effect";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { RecoveryCase } from "./recovery-case";

const maximumAdmissions = 4;
const maximumMarkerBytes = 512;
const Admission = Schema.Struct({
  reference: RecoveryCase.fields.reference,
  userId: RecoveryCase.fields.userId,
  requestedAtMs: RecoveryCase.fields.requestedAtMs,
});
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });

const verifyMarker = (
  input: Readonly<{ bucket: R2Bucket; record: typeof Admission.Type }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const object = yield* io(() => input.bucket.get(`recovery/cases/${input.record.reference}`));
    if (object === null) return false;
    if (object.size > maximumMarkerBytes) return yield* new ErasureUnavailable();
    const record = yield* Schema.decodeEffect(Schema.fromJsonString(RecoveryCase), {
      onExcessProperty: "error",
    })(yield* io(() => object.text()));
    if (
      record.reference !== input.record.reference ||
      record.userId !== input.record.userId ||
      record.requestedAtMs !== input.record.requestedAtMs
    ) {
      return yield* new ErasureUnavailable();
    }
    return true;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

/** Only under closed admission and a drained source. Source intents missing from an earlier snapshot must first become independent evidence; no external effect is replayed. */
export const preservePendingAdmissions = (
  input: Readonly<{ db: D1Database; bucket: R2Bucket; cursor: string }>
): Effect.Effect<Readonly<{ cursor: string; complete: boolean }>, ErasureUnavailable> =>
  Effect.gen(function* () {
    const result = yield* io(() =>
      input.db
        .prepare(
          "SELECT id AS reference,user_id AS userId,requested_at_ms AS requestedAtMs FROM erasure_requests WHERE id>? AND (state<>'Complete' OR marker_written=0) ORDER BY id LIMIT ?"
        )
        .bind(input.cursor, maximumAdmissions)
        .all()
    );
    const records = yield* Schema.decodeUnknownEffect(Schema.Array(Admission))(result.results);
    for (const record of records) {
      if (yield* verifyMarker({ ...input, record })) continue;
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryCase))({
        ...record,
        sealed: false,
      });
      yield* io(() =>
        input.bucket.put(`recovery/cases/${record.reference}`, body, {
          onlyIf: { etagDoesNotMatch: "*" },
        })
      );
      if (!(yield* verifyMarker({ ...input, record }))) return yield* new ErasureUnavailable();
    }
    return {
      cursor: records.at(-1)?.reference ?? input.cursor,
      complete: records.length < maximumAdmissions,
    };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
