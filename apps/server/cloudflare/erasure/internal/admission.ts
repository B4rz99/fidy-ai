import { Clock, Effect, Option, Schema } from "effect";
import { ErasureReceipt } from "../../../src/core/erasure/contract";
import { webSessionCredentialAuthority } from "../../../src/shell/web-session/operations";
import type { ErasureBrowserAdmission, ErasureRecoveryConfiguration } from "../contract";
import { type ErasureStore, ErasureUnavailable } from "../../erasure-store/contract";
import { newId } from "../../secret-material/operations";
import { expectedGeneration, generationAssertion } from "./generation";
import { publishDeletionMarker } from "./checkpoint";
import { receiptNext } from "./receipt";
import { RecoveryCase } from "./recovery-case";

const maximumMarkerBytes = 512;
const Stored = Schema.Struct({
  reference: ErasureReceipt.fields.reference,
  state: ErasureReceipt.fields.state,
  requestedAtMs: Schema.Int,
  connectionBlocked: Schema.Literals([0, 1]),
});
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
type Admission = Readonly<{
  db: D1Database;
  admission: ErasureBrowserAdmission;
  signal: AbortSignal;
  stores: ReadonlyArray<ErasureStore>;
  recovery: ErasureRecoveryConfiguration;
}>;

export const admitDeletion = (
  input: Admission
): Effect.Effect<Option.Option<typeof ErasureReceipt.Type>, ErasureUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const { admission, db } = input;
    if (input.signal.aborted || admission.deadlineMs <= current) return Option.none();
    const expected = yield* expectedGeneration(input.recovery);
    const rows = yield* claimAdmission({ ...input, current, generation: expected.generation });
    const raw = Option.fromUndefinedOr(rows.at(-1)?.results[0]);
    if (Option.isNone(raw)) return Option.none();
    const stored = yield* Schema.decodeUnknownEffect(Stored)(raw.value);
    const record = {
      reference: stored.reference,
      userId: admission.userId,
      requestedAtMs: stored.requestedAtMs,
      sealed: false,
    };
    const present = yield* markerExists({ ...input, record });
    const publication = present
      ? []
      : (yield* publishDeletionMarker({ configuration: input.recovery, record })).checkpoint;
    yield* finalizeAdmission({
      ...input,
      stored,
      publication,
      replayCheckpoint: present
        ? [generationAssertion({ db, generation: expected.generation })]
        : [],
    });
    return Option.some({
      reference: stored.reference,
      state: stored.state,
      next: receiptNext(stored),
    });
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const claimAdmission = (
  input: Admission & Readonly<{ current: number; generation: string }>
): Effect.Effect<ReadonlyArray<D1Result>, ErasureUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { admission, db, current } = input;
    const proof = webSessionCredentialAuthority({
      subject: {
        id: admission.sessionId,
        userId: admission.userId,
        digest: new Uint8Array(admission.digest),
      },
      current,
    });
    const reference = yield* Effect.sync(newId);
    const inventory = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(Schema.String))
    )(input.stores.map((store) => store.id));
    return yield* io(() =>
      db.batch([
        generationAssertion({ db, generation: input.generation }),
        db
          .prepare(`INSERT INTO erasure_requests(id,user_id,requested_at_ms,state)
        SELECT ?,?,?,'Draining' WHERE EXISTS(SELECT 1 FROM ${proof.table} WHERE ${proof.predicate} AND fresh_until_ms>?)
        ON CONFLICT(user_id) DO NOTHING`)
          .bind(reference, admission.userId, current, ...proof.bindings, current),
        db
          .prepare(`INSERT INTO erasure_steps(request_id,store_id)
        SELECT q.id,s.value FROM erasure_requests q,json_each(?) s
        WHERE q.user_id=? AND EXISTS(SELECT 1 FROM ${proof.table} WHERE ${proof.predicate} AND fresh_until_ms>?)
        ON CONFLICT(request_id,store_id) DO NOTHING`)
          .bind(inventory, admission.userId, ...proof.bindings, current),
        db
          .prepare(`INSERT INTO erasure_custody_records(record_type,request_id,custodian,state)
        SELECT 'current',q.id,p.value,'Pending' FROM erasure_requests q,json_each('["Cloudflare","Kapso","Meta","Resend","Wompi"]') p
        WHERE q.user_id=? AND EXISTS(SELECT 1 FROM ${proof.table} WHERE ${proof.predicate} AND fresh_until_ms>?)
        ON CONFLICT(request_id,custodian) WHERE record_type='current' DO NOTHING`)
          .bind(admission.userId, ...proof.bindings, current),
        db
          .prepare(`SELECT id AS reference,state,requested_at_ms AS requestedAtMs,connection_blocked AS connectionBlocked FROM erasure_requests WHERE user_id=?
        AND EXISTS(SELECT 1 FROM ${proof.table} WHERE ${proof.predicate} AND fresh_until_ms>?)`)
          .bind(admission.userId, ...proof.bindings, current),
      ])
    );
  });

const finalizeAdmission = (
  input: Admission &
    Readonly<{
      stored: typeof Stored.Type;
      publication: ReadonlyArray<D1PreparedStatement>;
      replayCheckpoint: ReadonlyArray<D1PreparedStatement>;
    }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { admission, db, stored, publication } = input;
    const committedAt = yield* Clock.currentTimeMillis;
    if (input.signal.aborted || admission.deadlineMs <= committedAt) {
      return yield* new ErasureUnavailable();
    }
    const committedProof = webSessionCredentialAuthority({
      subject: {
        id: admission.sessionId,
        userId: admission.userId,
        digest: new Uint8Array(admission.digest),
      },
      current: committedAt,
    });
    yield* io(() =>
      db.batch([
        ...publication,
        ...input.replayCheckpoint,
        db
          .prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM erasure_requests WHERE id=? AND user_id=? AND requested_at_ms=?)
        AND EXISTS(SELECT 1 FROM ${committedProof.table} WHERE ${committedProof.predicate} AND fresh_until_ms>?)
        THEN 'true' ELSE '' END) AS accepted`)
          .bind(
            stored.reference,
            admission.userId,
            stored.requestedAtMs,
            ...committedProof.bindings,
            committedAt
          ),
      ])
    );
  });

const markerExists = (
  input: Admission & Readonly<{ record: typeof RecoveryCase.Type }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    if (Option.isNone(input.recovery.bucket)) return yield* new ErasureUnavailable();
    const bucket = input.recovery.bucket.value;
    const object = yield* io(() => bucket.get(`recovery/cases/${input.record.reference}`));
    if (object === null) return false;
    if (object.size > maximumMarkerBytes) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    const stored = yield* Schema.decodeEffect(Schema.fromJsonString(RecoveryCase), {
      onExcessProperty: "error",
    })(yield* io(() => object.text()));
    if (
      stored.reference !== input.record.reference ||
      stored.userId !== input.record.userId ||
      stored.requestedAtMs !== input.record.requestedAtMs
    ) {
      return yield* new ErasureUnavailable();
    }
    return true;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
