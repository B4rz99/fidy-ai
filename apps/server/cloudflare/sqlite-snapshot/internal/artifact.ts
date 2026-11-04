import { Effect, Schema } from "effect";
import { Hex } from "effect/encoding";
import { RecoveryTarget } from "../../recovery-activation/contract";
import { digestBytes } from "../../secret-material/operations";
import {
  SnapshotArtifact,
  type SnapshotArtifactRead,
  SnapshotDigest,
  SnapshotUnavailable,
  snapshotPageBytes,
} from "../contract";

export const artifactIo = <A>(work: () => Promise<A>): Effect.Effect<A, SnapshotUnavailable> =>
  Effect.tryPromise({ try: work, catch: () => new SnapshotUnavailable() });
export const artifactScope = (
  input: Readonly<{ activationId: string; target: RecoveryTarget }>
): Effect.Effect<string, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const target = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryTarget))(input.target);
    const digest = Hex.encode(yield* digestBytes(new TextEncoder().encode(target)));
    return `${input.activationId}/${digest}`;
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
export const artifactRead = (
  input: SnapshotArtifactRead
): Effect.Effect<SnapshotArtifact, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const digest = yield* Schema.decodeEffect(SnapshotDigest)(input.digest);
    const scope = yield* artifactScope(input);
    const key = `recovery/sqlite-snapshots/objects/${scope}/${digest}`;
    const object = yield* artifactIo(() => input.artifacts.get(key));
    if (object === null) return yield* new SnapshotUnavailable();
    if (object.size > snapshotPageBytes) {
      yield* artifactIo(() => object.body.cancel());
      return yield* new SnapshotUnavailable();
    }
    const bytes = new Uint8Array(yield* artifactIo(() => object.arrayBuffer()));
    if (Hex.encode(yield* digestBytes(bytes)) !== digest) return yield* new SnapshotUnavailable();
    return yield* Schema.decodeEffect(Schema.fromJsonString(SnapshotArtifact))(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  }).pipe(Effect.catchCause(() => Effect.fail(new SnapshotUnavailable())));
export const artifactPut = (
  input: Readonly<{
    artifacts: R2Bucket;
    activationId: string;
    target: RecoveryTarget;
    artifact: SnapshotArtifact;
  }>
): Effect.Effect<string, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SnapshotArtifact))(
      input.artifact
    );
    const bytes = new TextEncoder().encode(encoded);
    if (bytes.byteLength > snapshotPageBytes) return yield* new SnapshotUnavailable();
    const digest = Hex.encode(yield* digestBytes(bytes));
    const scope = yield* artifactScope(input);
    const key = `recovery/sqlite-snapshots/objects/${scope}/${digest}`;
    const result = yield* artifactIo(() =>
      input.artifacts.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
      })
    );
    if (result === null) yield* artifactRead({ ...input, digest });
    return digest;
  }).pipe(Effect.catchCause(() => Effect.fail(new SnapshotUnavailable())));
