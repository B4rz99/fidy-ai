import { Effect, Option, Schema } from "effect";
import { RecoveryClosedSourceEvidence, RecoveryTarget } from "../../recovery-activation/contract";
import { makeSqliteDatabase } from "../../sqlite-store/operations";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { expectedGeneration } from "./generation";
import { checkpointDigest, emptyLedgerDigest, verifyLedgerPage } from "./imported-ledger";
import { advanceImportedMarker } from "./imported-marker";
import {
  ErasureImportedCheckpoint as ImportedCheckpoint,
  type ErasureImportedInput as ImportedInput,
} from "../contract";

const maximumCheckpointBytes = 4096;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
const inactive = (input: ImportedInput): Effect.Effect<void, ErasureUnavailable> =>
  Effect.try({ try: () => input.target.assertInactive(), catch: () => new ErasureUnavailable() });
const currentCheckpoint = (input: ImportedInput): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const current = yield* expectedGeneration({
      db: makeSqliteDatabase(input.target.storage),
      bucket: Option.some(input.bucket),
    });
    if (
      current.generation !== input.evidence.finalGeneration ||
      current.etag !== input.evidence.finalCheckpointEtag
    ) {
      return yield* new ErasureUnavailable();
    }
  });
const requireTarget = (input: ImportedInput): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* inactive(input);
    const source = input.evidence.source;
    if (
      input.target.activationId !== input.evidence.activationId ||
      input.target.objectId !== input.target.target.objectId ||
      source.epoch === input.target.target.epoch ||
      input.evidence.sourceGeneration === input.evidence.finalGeneration ||
      (source.kind === "SQLite" &&
        (source.namespaceId === input.target.target.namespaceId ||
          source.objectId === input.target.objectId))
    ) {
      return yield* new ErasureUnavailable();
    }
    yield* currentCheckpoint(input);
  });
const previousCheckpoint = (
  input: ImportedInput,
  key: string,
  evidenceDigest: string
): Effect.Effect<
  Option.Option<Readonly<{ object: R2ObjectBody; checkpoint: ImportedCheckpoint }>>,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    const previous = Option.fromNullOr(yield* io(() => input.bucket.get(key)));
    if (Option.isNone(previous)) return Option.none();
    if (previous.value.size > maximumCheckpointBytes) {
      yield* io(() => previous.value.body.cancel());
      return yield* new ErasureUnavailable();
    }
    const checkpoint = yield* Schema.decodeEffect(Schema.fromJsonString(ImportedCheckpoint), {
      onExcessProperty: "error",
    })(yield* io(() => previous.value.text()));
    const target = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryTarget))(
      input.target.target
    );
    const recordedTarget = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryTarget))(
      checkpoint.target
    );
    if (
      checkpoint.artifactDigest !== input.target.artifactDigest ||
      checkpoint.evidenceDigest !== evidenceDigest ||
      target !== recordedTarget
    ) {
      return yield* new ErasureUnavailable();
    }
    return Option.some({ object: previous.value, checkpoint });
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const storeCheckpoint = ({
  input,
  checkpoint,
  key,
  previous,
}: Readonly<{
  input: ImportedInput;
  checkpoint: ImportedCheckpoint;
  key: string;
  previous: Option.Option<Readonly<{ object: R2ObjectBody }>>;
}>): Effect.Effect<ImportedCheckpoint, ErasureUnavailable> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ImportedCheckpoint))(
      checkpoint
    );
    const written = yield* io(() =>
      input.bucket.put(key, encoded, {
        onlyIf: Option.isSome(previous)
          ? { etagMatches: previous.value.object.etag }
          : { etagDoesNotMatch: "*" },
      })
    );
    if (written === null) return yield* new ErasureUnavailable();
    return checkpoint;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

/** Verifies an inactive frozen import; this local erasure observation never opens serving admission or qualifies provider isolation. */
export const verifyImported = (
  input: ImportedInput
): Effect.Effect<ImportedCheckpoint, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* Schema.decodeEffect(RecoveryClosedSourceEvidence)(input.evidence);
    yield* requireTarget(input);
    const encodedEvidence = yield* Schema.encodeEffect(
      Schema.fromJsonString(RecoveryClosedSourceEvidence)
    )(input.evidence);
    const evidenceDigest = yield* checkpointDigest(encodedEvidence);
    const key = `recovery/imported-erasure/${input.target.artifactDigest}/${input.target.objectId}`;
    const previous = yield* previousCheckpoint(input, key, evidenceDigest);
    const initial: ImportedCheckpoint =
      Option.isSome(previous) && previous.value.checkpoint.state === "Verifying"
        ? previous.value.checkpoint
        : {
            artifactDigest: input.target.artifactDigest,
            target: input.target.target,
            evidenceDigest,
            cursor: "",
            lastKey: "",
            checkedCases: 0,
            digest: emptyLedgerDigest,
            state: "Verifying",
            providerIsolation: "Unqualified",
          };
    const checkpoint = yield* verifyLedgerPage({ input, previous: initial });
    yield* currentCheckpoint(input);
    if (checkpoint.state === "Verified") {
      if (checkpoint.digest !== input.evidence.ledgerDigest) return yield* new ErasureUnavailable();
      yield* advanceImportedMarker({ input, checkedCases: checkpoint.checkedCases });
    }
    yield* currentCheckpoint(input);
    yield* inactive(input);
    return yield* storeCheckpoint({ input, checkpoint, key, previous });
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
