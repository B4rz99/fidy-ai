import { Clock, Effect, Option, Schema } from "effect";
import { ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureOperatorEnvironment } from "../contract";
import { ErasureGeneration } from "../contract";
import { RecoveryCase } from "./recovery-case";
import { expectedGeneration } from "./generation";
import { recoveryWindowMs } from "./retention-policy";

const maximumCases = 4;
const maximumCaseBytes = 512;
const maximumCheckpointBytes = 4096;
const Checkpoint = Schema.Struct({
  targetId: Schema.String,
  generation: ErasureGeneration,
  state: Schema.Literals(["Verifying", "Verified"]),
  cursor: Schema.String,
  checkedCases: Schema.Int,
  verifiedAtMs: Schema.Int,
  providerIsolation: Schema.Literal("Unqualified"),
});
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });

const decodeObject = <Shape extends Schema.Top & { readonly DecodingServices: never }>(
  object: R2ObjectBody,
  schema: Shape,
  maximumBytes: number
): Effect.Effect<Shape["Type"], ErasureUnavailable> =>
  Effect.gen(function* () {
    if (object.size > maximumBytes) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema), { onExcessProperty: "error" })(
      yield* io(() => object.text())
    );
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const disposed = (
  db: D1Database,
  record: typeof RecoveryCase.Type,
  generation: string
): Effect.Effect<boolean, ErasureUnavailable> =>
  io(() =>
    db
      .prepare(`SELECT EXISTS(SELECT 1 FROM erasure_requests q
    JOIN erasure_restore_members m ON m.request_id=q.id AND m.user_id=q.user_id
    WHERE q.id=? AND q.user_id=? AND q.requested_at_ms=? AND m.generation=? AND q.restore_generation=m.generation
    AND q.state IN('ExternalPending','Complete') AND q.marker_written=1 AND q.coordinator_cleared=1
    AND NOT EXISTS(SELECT 1 FROM users WHERE id=q.user_id)
    AND EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id)
    AND NOT EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id AND delete_done=0)
    AND NOT EXISTS(SELECT 1 FROM erasure_writers WHERE user_id=q.user_id)) AS ready`)
      .bind(record.reference, record.userId, record.requestedAtMs, generation)
      .first<number>("ready")
  ).pipe(Effect.map((ready) => record.sealed && ready === 1));

const completeReplay = (
  input: Readonly<{ db: D1Database; generation: string; current: number; checkedCases: number }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  io(() =>
    input.db
      .prepare(`SELECT (SELECT count(*) FROM erasure_restore_members WHERE generation=?)=? AND EXISTS(SELECT 1 FROM erasure_control WHERE kind='restore' AND generation=? AND scanned=1)
    AND NOT EXISTS(SELECT 1 FROM erasure_restore_members m LEFT JOIN erasure_requests q ON q.id=m.request_id
      WHERE m.generation=? AND (q.id IS NULL OR q.user_id<>m.user_id OR q.restore_generation IS NOT m.generation
      OR q.state NOT IN('ExternalPending','Complete') OR NOT EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id)
      OR EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id AND delete_done=0)))
    AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE NOT EXISTS(SELECT 1 FROM erasure_restore_members m WHERE m.generation=? AND m.request_id=q.id AND m.user_id=q.user_id)
      AND NOT(q.state='Complete' AND q.last_erased_at_ms IS NOT NULL AND q.last_erased_at_ms+?<=? AND q.marker_written=1 AND q.coordinator_cleared=1
        AND NOT EXISTS(SELECT 1 FROM erasure_writers WHERE user_id=q.user_id))) AS ready`)
      .bind(
        input.generation,
        input.checkedCases,
        input.generation,
        input.generation,
        input.generation,
        recoveryWindowMs,
        input.current
      )
      .first<number>("ready")
  ).pipe(Effect.map((ready) => ready === 1));

type CandidateInput = Readonly<{
  environment: ErasureOperatorEnvironment;
  targetId: string;
  signal: AbortSignal;
  expiresAtMs: number;
}>;
const acceptedStatus = 202;
const successStatus = 200;
const pending = (): Response =>
  Response.json(
    { state: "AwaitingDisposition", providerIsolation: "Unqualified" },
    { status: acceptedStatus, headers: { "cache-control": "no-store" } }
  );
const requireCurrent = (input: CandidateInput): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    if (input.signal.aborted || (yield* Clock.currentTimeMillis) >= input.expiresAtMs) {
      return yield* new ErasureUnavailable();
    }
  });
type Session = Readonly<{
  key: string;
  object: Option.Option<R2ObjectBody>;
  cursor: string;
  checkedCases: number;
}>;
const readSession = (
  input: CandidateInput & Readonly<{ bucket: R2Bucket; generation: string }>
): Effect.Effect<Session, ErasureUnavailable> =>
  Effect.gen(function* () {
    const key = `recovery/candidates/${input.targetId}`;
    const object = Option.fromNullOr(yield* io(() => input.bucket.get(key)));
    const stored = Option.isNone(object)
      ? Option.none()
      : Option.some(yield* decodeObject(object.value, Checkpoint, maximumCheckpointBytes));
    if (Option.isSome(stored) && stored.value.targetId !== input.targetId) {
      return yield* new ErasureUnavailable();
    }
    const previous = Option.filter(
      stored,
      (value) => value.generation === input.generation && value.state === "Verifying"
    );
    return {
      key,
      object,
      cursor: Option.match(previous, { onNone: () => "", onSome: (value) => value.cursor }),
      checkedCases: Option.match(previous, {
        onNone: () => 0,
        onSome: (value) => value.checkedCases,
      }),
    };
  });
const verifyPage = (
  input: CandidateInput & Readonly<{ bucket: R2Bucket; generation: string; page: R2Objects }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    for (const entry of input.page.objects) {
      yield* requireCurrent(input);
      const ledger = yield* io(() => input.bucket.get(entry.key));
      if (ledger === null) return yield* new ErasureUnavailable();
      const record = yield* decodeObject(ledger, RecoveryCase, maximumCaseBytes);
      if (entry.key !== `recovery/cases/${record.reference}`) {
        return yield* new ErasureUnavailable();
      }
      if (!(yield* disposed(input.environment.DB, record, input.generation))) return false;
    }
    return true;
  });
const writeCheckpoint = (
  input: CandidateInput &
    Readonly<{
      bucket: R2Bucket;
      expected: { generation: typeof ErasureGeneration.Type; etag: string };
      session: Session;
      page: R2Objects;
      ready: boolean;
      current: number;
    }>
): Effect.Effect<Response, ErasureUnavailable> =>
  Effect.gen(function* () {
    const checked = yield* expectedGeneration({
      db: input.environment.DB,
      bucket: Option.some(input.bucket),
    });
    yield* requireCurrent(input);
    if (checked.etag !== input.expected.etag) return yield* new ErasureUnavailable();
    const checkpoint = yield* Schema.decodeEffect(Checkpoint)({
      targetId: input.targetId,
      generation: input.expected.generation,
      state: input.ready ? "Verified" : "Verifying",
      cursor: input.page.truncated ? input.page.cursor : "",
      checkedCases: input.session.checkedCases + input.page.objects.length,
      verifiedAtMs: input.current,
      providerIsolation: "Unqualified",
    });
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Checkpoint))(checkpoint);
    const written = yield* io(() =>
      input.bucket.put(input.session.key, encoded, {
        onlyIf: Option.match(input.session.object, {
          onNone: () => ({ etagDoesNotMatch: "*" }),
          onSome: (object) => ({ etagMatches: object.etag }),
        }),
      })
    );
    if (written === null) return yield* new ErasureUnavailable();
    return Response.json(checkpoint, {
      status: input.ready ? successStatus : acceptedStatus,
      headers: { "cache-control": "no-store" },
    });
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
export const verifyCandidate = (
  input: CandidateInput
): Effect.Effect<Response, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* requireCurrent(input);
    const bucket = Option.fromUndefinedOr(input.environment.ERASURE_BUCKET);
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const configuration = { db: input.environment.DB, bucket };
    const expected = yield* expectedGeneration(configuration);
    const session = yield* readSession({
      ...input,
      bucket: bucket.value,
      generation: expected.generation,
    });
    const page = yield* io(() =>
      bucket.value.list({
        prefix: "recovery/cases/",
        limit: maximumCases,
        ...(session.cursor === "" ? {} : { cursor: session.cursor }),
      })
    );
    if (
      !(yield* verifyPage({
        ...input,
        bucket: bucket.value,
        generation: expected.generation,
        page,
      }))
    ) {
      return pending();
    }
    const current = yield* Clock.currentTimeMillis;
    const ready =
      !page.truncated &&
      (yield* completeReplay({
        db: input.environment.DB,
        generation: expected.generation,
        current,
        checkedCases: session.checkedCases + page.objects.length,
      }));
    if (!page.truncated && !ready) return pending();
    return yield* writeCheckpoint({
      ...input,
      bucket: bucket.value,
      expected,
      session,
      page,
      ready,
      current,
    });
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
