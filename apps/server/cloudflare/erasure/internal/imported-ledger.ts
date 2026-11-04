import { Effect, Schema } from "effect";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { makeSqliteDatabase } from "../../sqlite-store/operations";
import { RecoveryCase } from "./recovery-case";
import type {
  ErasureImportedCheckpoint as ImportedCheckpoint,
  ErasureImportedInput as ImportedInput,
} from "../contract";

export const emptyLedgerDigest = "76754952062edeaa4c3dfe85e9183518bf01f927ee1564d0868c52b35523eca5";
const maximumCaseBytes = 512;
const hexadecimalRadix = 16;
const maximumCases = 4;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
export const checkpointDigest = (value: string): Effect.Effect<string, ErasureUnavailable> =>
  io(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((bytes) =>
      Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(hexadecimalRadix).padStart(2, "0")
      ).join("")
    )
  );
const verifyCase = (
  input: ImportedInput,
  record: typeof RecoveryCase.Type
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => input.target.assertInactive(),
      catch: () => new ErasureUnavailable(),
    });
    const db = makeSqliteDatabase(input.target.storage);
    yield* io(() =>
      db.batch([
        db
          .prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM erasure_requests q
      WHERE q.id=? AND q.user_id=? AND q.requested_at_ms=?
      AND q.state IN('ExternalPending','Complete') AND q.marker_written=1 AND q.coordinator_cleared=1
      AND NOT EXISTS(SELECT 1 FROM users WHERE id=q.user_id)
      AND EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id AND delete_done=0)
      AND NOT EXISTS(SELECT 1 FROM erasure_writers WHERE user_id=q.user_id))
      AND EXISTS(SELECT 1 FROM erasure_control WHERE kind='published' AND generation IN(?,?))
      THEN 'true' ELSE '' END) AS verified`)
          .bind(
            record.reference,
            record.userId,
            record.requestedAtMs,
            input.evidence.sourceGeneration,
            input.evidence.finalGeneration
          ),
        db
          .prepare(
            "INSERT INTO erasure_restore_members(generation,request_id,user_id) VALUES(?,?,?) ON CONFLICT DO NOTHING"
          )
          .bind(input.evidence.finalGeneration, record.reference, record.userId),
      ])
    );
  });
const readCase = (
  input: ImportedInput,
  listed: R2Object
): Effect.Effect<
  Readonly<{ record: typeof RecoveryCase.Type; body: string }>,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    const object = yield* io(() => input.bucket.get(listed.key));
    if (object === null) return yield* new ErasureUnavailable();
    if (object.size > maximumCaseBytes || object.etag !== listed.etag) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    const body = yield* io(() => object.text());
    const record = yield* Schema.decodeEffect(Schema.fromJsonString(RecoveryCase), {
      onExcessProperty: "error",
    })(body);
    if (!record.sealed || listed.key !== `recovery/cases/${record.reference}`) {
      return yield* new ErasureUnavailable();
    }
    return { record, body };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
export const verifyLedgerPage = ({
  input,
  previous,
}: Readonly<{ input: ImportedInput; previous: ImportedCheckpoint }>): Effect.Effect<
  ImportedCheckpoint,
  ErasureUnavailable
> =>
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
      const { record, body } = yield* readCase(input, listed);
      yield* verifyCase(input, record);
      const bodyDigest = yield* checkpointDigest(body);
      const serialized = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Array(Schema.String))
      )([progress.digest, listed.key, listed.etag, bodyDigest]);
      progress = {
        ...progress,
        digest: yield* checkpointDigest(serialized),
        lastKey: listed.key,
        checkedCases: progress.checkedCases + 1,
      };
    }
    return {
      ...progress,
      cursor: page.truncated ? page.cursor : "",
      state: page.truncated ? ("Verifying" as const) : ("Verified" as const),
    };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
