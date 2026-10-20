import { Clock, Effect, Option, Schema } from "effect";
import type { ErasureOperatorEnvironment } from "../contract";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { expectedGeneration } from "./generation";
import { RecoveryCase } from "./recovery-case";

const maximumCases = 4;
const acceptedStatus = 202;
const successStatus = 200;
const maximumCaseBytes = 32768;
const admissionLifetimeMs = 5000;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
type RestoreInput = Readonly<{
  environment: ErasureOperatorEnvironment;
  operator: Readonly<{ operatorRef: string; expiresAtMs: number }>;
  signal: AbortSignal;
}>;
const readRecord = (
  input: Readonly<{ bucket: R2Bucket; key: string }>
): Effect.Effect<typeof RecoveryCase.Type, ErasureUnavailable> =>
  Effect.gen(function* () {
    const object = yield* io(() => input.bucket.get(input.key));
    if (object === null) return yield* new ErasureUnavailable();
    if (object.size > maximumCaseBytes) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    const record = yield* Schema.decodeEffect(Schema.fromJsonString(RecoveryCase))(
      yield* io(() => object.text())
    );
    if (input.key !== `recovery/cases/${record.decision.reference}`) {
      return yield* new ErasureUnavailable();
    }
    return record;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const restoreOne = (
  input: RestoreInput & Readonly<{ record: typeof RecoveryCase.Type; generation: string }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (current >= input.operator.expiresAtMs || input.signal.aborted) {
      return yield* new ErasureUnavailable();
    }
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      reference: input.record.decision.reference,
      userId: input.record.decision.userId,
      generation: input.generation,
      deadlineMs: Math.min(current + admissionLifetimeMs, input.operator.expiresAtMs),
      authority: { permission: "titular.erase", ...input.operator },
    });
    const response = yield* io(() =>
      input.environment.USER_TRANSACTION_COORDINATOR.getByName(input.record.decision.userId).fetch(
        new Request("https://coordinator.internal/erasure-restore", {
          method: "POST",
          body,
          signal: input.signal,
        })
      )
    );
    if (response.status !== acceptedStatus) return yield* new ErasureUnavailable();
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const Session = Schema.Struct({ cursor: Schema.String, scanned: Schema.Literals([0, 1]) });
export const restoreNext = (input: RestoreInput): Effect.Effect<Response, ErasureUnavailable> =>
  Effect.gen(function* () {
    const bucket = Option.fromUndefinedOr(input.environment.ERASURE_BUCKET);
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const configuration = { db: input.environment.DB, bucket };
    const expected = yield* expectedGeneration(configuration);
    const { db } = configuration;
    const results = yield* io(() =>
      db.batch([
        db
          .prepare(`INSERT INTO erasure_control(kind,generation,cursor,scanned) VALUES('restore',?,'',0)
      ON CONFLICT(kind) DO UPDATE SET generation=excluded.generation,cursor='',scanned=0 WHERE erasure_control.generation<>excluded.generation`)
          .bind(expected.generation),
        db
          .prepare(
            "SELECT cursor,scanned FROM erasure_control WHERE kind='restore' AND generation=?"
          )
          .bind(expected.generation),
      ])
    );
    const session = yield* Schema.decodeUnknownEffect(Session)(results[1]?.results[0]);
    if (session.scanned === 1) {
      return Response.json(
        { state: "AwaitingDisposition" },
        { status: acceptedStatus, headers: { "cache-control": "no-store" } }
      );
    }
    const page = yield* io(() =>
      bucket.value.list({
        prefix: "recovery/cases/",
        limit: maximumCases,
        ...(session.cursor === "" ? {} : { cursor: session.cursor }),
      })
    );
    for (const object of page.objects) {
      const record = yield* readRecord({ bucket: bucket.value, key: object.key });
      yield* restoreOne({ ...input, record, generation: expected.generation });
    }
    yield* io(() =>
      db
        .prepare(
          "UPDATE erasure_control SET cursor=?,scanned=? WHERE kind='restore' AND generation=? AND cursor=? AND scanned=0"
        )
        .bind(
          page.truncated ? page.cursor : "",
          page.truncated ? 0 : 1,
          expected.generation,
          session.cursor
        )
        .run()
    );
    return Response.json(
      { state: page.truncated ? "Replaying" : "AwaitingDisposition" },
      { status: acceptedStatus, headers: { "cache-control": "no-store" } }
    );
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

export const releaseRestore = (input: RestoreInput): Effect.Effect<Response, ErasureUnavailable> =>
  Effect.gen(function* () {
    const configuration = {
      db: input.environment.DB,
      bucket: Option.fromUndefinedOr(input.environment.ERASURE_BUCKET),
    };
    const expected = yield* expectedGeneration(configuration);
    const current = yield* Clock.currentTimeMillis;
    if (current >= input.operator.expiresAtMs || input.signal.aborted) {
      return yield* new ErasureUnavailable();
    }
    const { db } = configuration;
    const result = yield* io(() =>
      db
        .prepare(`UPDATE erasure_control SET generation=? WHERE kind='published'
    AND EXISTS(SELECT 1 FROM erasure_control WHERE kind='restore' AND generation=? AND scanned=1)
    AND NOT EXISTS(SELECT 1 FROM erasure_restore_members m LEFT JOIN erasure_requests q ON q.id=m.request_id
      WHERE m.generation=? AND (q.id IS NULL OR q.user_id<>m.user_id OR q.restore_generation IS NOT m.generation
      OR q.state NOT IN('ExternalPending','Complete') OR NOT EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id) OR EXISTS(SELECT 1 FROM erasure_steps s WHERE s.request_id=q.id AND s.delete_done=0)
      OR EXISTS(SELECT 1 FROM erasure_objects o WHERE o.request_id=q.id AND o.done=0)))
    AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.decision_json IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM erasure_restore_members m WHERE m.generation=? AND m.request_id=q.id AND m.user_id=q.user_id))`)
        .bind(expected.generation, expected.generation, expected.generation, expected.generation)
        .run()
    );
    return Response.json(
      { state: result.meta.changes === 1 ? "Released" : "AwaitingDisposition" },
      {
        status: result.meta.changes === 1 ? successStatus : acceptedStatus,
        headers: { "cache-control": "no-store" },
      }
    );
  });
