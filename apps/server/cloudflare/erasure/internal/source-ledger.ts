import { Clock, Effect, Option, Schema } from "effect";
import { ErasureUnavailable } from "../../erasure-store/contract";
import {
  type ErasureFrozenLedgerInput as Input,
  ErasureFrozenLedgerProgress as Progress,
} from "../contract";
import { expectedGeneration, generationAssertion } from "./generation";
import { checkpointDigest, emptyLedgerDigest, readLedgerCase } from "./imported-ledger";
import { RecoveryCase } from "./recovery-case";
import { recoveryWindowMs } from "./retention-policy";

const maximumCases = 4;
const Request = Schema.Struct({
  reference: RecoveryCase.fields.reference,
  userId: RecoveryCase.fields.userId,
  requestedAtMs: RecoveryCase.fields.requestedAtMs,
});
const io = <A>(work: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: work, catch: () => new ErasureUnavailable() });
const stable = (input: Input, progress: Progress): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const checkpoint = yield* expectedGeneration({
      db: input.db,
      bucket: Option.some(input.bucket),
    });
    if (
      progress.generation !== input.generation ||
      checkpoint.generation !== progress.registryGeneration ||
      checkpoint.etag !== progress.registryEtag ||
      checkpoint.generation === input.generation
    ) {
      return yield* new ErasureUnavailable();
    }
  });
const initial = (input: Input): Effect.Effect<Progress, ErasureUnavailable> =>
  Effect.gen(function* () {
    if (Option.isSome(input.previous)) {
      yield* stable(input, input.previous.value);
      if (input.previous.value.state === "Observing") return input.previous.value;
    }
    const checkpoint = yield* expectedGeneration({
      db: input.db,
      bucket: Option.some(input.bucket),
    });
    const generation = yield* Schema.decodeEffect(Progress.fields.generation)(input.generation);
    if (checkpoint.generation === generation) return yield* new ErasureUnavailable();
    yield* io(() => input.db.batch([generationAssertion({ db: input.db, generation })]));
    return {
      generation,
      registryGeneration: checkpoint.generation,
      registryEtag: checkpoint.etag,
      capturedAtMs: yield* Clock.currentTimeMillis,
      cursor: "",
      lastKey: "",
      checkedCases: 0,
      checkedRequiredCases: 0,
      checkedRequests: 0,
      requiredDigest: emptyLedgerDigest,
      requestsDigest: emptyLedgerDigest,
      requestCursor: "",
      phase: "Ledger" as const,
      digest: emptyLedgerDigest,
      state: "Observing" as const,
      providerIsolation: "Unqualified" as const,
    };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const extend = (
  input: Readonly<{ digest: string; key: string; etag: string; body: string }>
): Effect.Effect<string, ErasureUnavailable> =>
  Effect.gen(function* () {
    const bodyDigest = yield* checkpointDigest(input.body);
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
      input.digest,
      input.key,
      input.etag,
      bodyDigest,
    ]);
    return yield* checkpointDigest(encoded);
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const disposed = (
  input: Input,
  progress: Progress,
  record: typeof RecoveryCase.Type
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const result = yield* io(() =>
      input.db.batch([
        generationAssertion({ db: input.db, generation: progress.generation }),
        input.db
          .prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM erasure_requests q
      WHERE q.id=? AND q.user_id=? AND q.requested_at_ms=? AND q.state IN('ExternalPending','Complete')
      AND q.marker_written=1 AND q.coordinator_cleared=1
      AND NOT EXISTS(SELECT 1 FROM users WHERE id=q.user_id)
      AND EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id AND delete_done=0)
      AND NOT EXISTS(SELECT 1 FROM erasure_writers WHERE user_id=q.user_id)) THEN 'true' ELSE '' END) AS disposed`)
          .bind(record.reference, record.userId, record.requestedAtMs),
        input.db
          .prepare(
            `SELECT CASE WHEN state='Complete' AND last_erased_at_ms IS NOT NULL AND last_erased_at_ms+?<=? THEN 0 ELSE 1 END AS required FROM erasure_requests WHERE id=?`
          )
          .bind(recoveryWindowMs, progress.capturedAtMs, record.reference),
      ])
    );
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ required: Schema.Literals([0, 1]) })
    )(result[2]?.results[0]);
    return row.required === 1;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const ledger = (input: Input, previous: Progress): Effect.Effect<Progress, ErasureUnavailable> =>
  Effect.gen(function* () {
    const page = yield* io(() =>
      input.bucket.list({
        prefix: "recovery/cases/",
        limit: maximumCases,
        ...(previous.cursor === "" ? {} : { cursor: previous.cursor }),
      })
    );
    let progress = previous;
    for (const listed of page.objects) {
      if (listed.key <= progress.lastKey) return yield* new ErasureUnavailable();
      const { record, body } = yield* readLedgerCase({ bucket: input.bucket, listed });
      const required = yield* disposed(input, progress, record);
      const digest = yield* extend({
        digest: progress.digest,
        key: listed.key,
        etag: listed.etag,
        body,
      });
      const requiredDigest = required
        ? yield* extend({
            digest: progress.requiredDigest,
            key: listed.key,
            etag: listed.etag,
            body,
          })
        : progress.requiredDigest;
      progress = {
        ...progress,
        digest,
        requiredDigest,
        lastKey: listed.key,
        checkedCases: progress.checkedCases + 1,
        checkedRequiredCases: progress.checkedRequiredCases + (required ? 1 : 0),
      };
    }
    return {
      ...progress,
      cursor: page.truncated ? page.cursor : "",
      phase: page.truncated ? ("Ledger" as const) : ("Requests" as const),
    };
  });
const sameRequest = (actual: typeof RecoveryCase.Type, expected: typeof Request.Type): boolean =>
  actual.reference === expected.reference &&
  actual.userId === expected.userId &&
  actual.requestedAtMs === expected.requestedAtMs;
const requests = (input: Input, previous: Progress): Effect.Effect<Progress, ErasureUnavailable> =>
  Effect.gen(function* () {
    const result = yield* io(() =>
      input.db.batch([
        generationAssertion({ db: input.db, generation: previous.generation }),
        input.db
          .prepare(`SELECT id AS reference,user_id AS userId,requested_at_ms AS requestedAtMs FROM erasure_requests q
      WHERE id>? AND NOT(q.state='Complete' AND q.last_erased_at_ms IS NOT NULL AND q.last_erased_at_ms+?<=?
        AND q.marker_written=1 AND q.coordinator_cleared=1 AND NOT EXISTS(SELECT 1 FROM users WHERE id=q.user_id)) ORDER BY id LIMIT ?`)
          .bind(previous.requestCursor, recoveryWindowMs, previous.capturedAtMs, maximumCases),
        input.db.prepare(
          "SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_writers) THEN 'true' ELSE '' END) AS drained"
        ),
      ])
    );
    const records = yield* Schema.decodeUnknownEffect(Schema.Array(Request))(result[1]?.results);
    let progress = previous;
    for (const expected of records) {
      const key = `recovery/cases/${expected.reference}`;
      const listed = yield* io(() => input.bucket.head(key));
      if (listed === null) return yield* new ErasureUnavailable();
      const { record, body } = yield* readLedgerCase({ bucket: input.bucket, listed });
      if (!sameRequest(record, expected)) {
        return yield* new ErasureUnavailable();
      }
      progress = {
        ...progress,
        requestsDigest: yield* extend({
          digest: progress.requestsDigest,
          key,
          etag: listed.etag,
          body,
        }),
        requestCursor: record.reference,
        checkedRequests: progress.checkedRequests + 1,
      };
    }
    if (records.length === maximumCases) return progress;
    if (
      progress.checkedRequests !== progress.checkedRequiredCases ||
      progress.requestsDigest !== progress.requiredDigest
    ) {
      return yield* new ErasureUnavailable();
    }
    return { ...progress, state: "Observed" as const };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
/** Two read-only passes prove exact required coverage without modifying the frozen source. The caller persists all progress independently. */
export const observeSourceLedger = (input: Input): Effect.Effect<Progress, ErasureUnavailable> =>
  Effect.gen(function* () {
    let progress = yield* initial(input);
    if (progress.phase === "Ledger") progress = yield* ledger(input, progress);
    if (progress.phase === "Requests") progress = yield* requests(input, progress);
    yield* stable(input, progress);
    return progress;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
