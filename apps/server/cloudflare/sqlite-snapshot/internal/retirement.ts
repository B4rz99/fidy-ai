import { Effect, Schema } from "effect";
import { readRecoveryArtifactRetirement } from "../../recovery-activation/operations";
import { RecoveryArtifactRetirement } from "../../recovery-activation/contract";
import {
  type SnapshotArtifactRetirementInput,
  type SnapshotArtifactRetirementStatus,
  SnapshotUnavailable,
} from "../contract";
import { artifactIo, artifactScope } from "./artifact";

const pageSize = 100;
const Request = Schema.Struct({
  activationId: RecoveryArtifactRetirement.fields.activationId,
  target: RecoveryArtifactRetirement.fields.target,
  artifactDigest: RecoveryArtifactRetirement.fields.artifactDigest,
});
const Page = Schema.Struct({
  objects: Schema.Array(Schema.Struct({ key: Schema.String })).check(Schema.isMaxLength(pageSize)),
  truncated: Schema.Boolean,
});
const authorize = (
  input: SnapshotArtifactRetirementInput
): Effect.Effect<void, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const expected = yield* Schema.decodeEffect(Request)(input);
    const authority = yield* readRecoveryArtifactRetirement(expected).pipe(
      Effect.flatMap(Schema.decodeEffect(RecoveryArtifactRetirement))
    );
    const requested = yield* Schema.encodeEffect(Schema.fromJsonString(Request))(expected);
    const observed = yield* Schema.encodeEffect(Schema.fromJsonString(Request))(authority);
    if (requested !== observed) return yield* new SnapshotUnavailable();
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
const retirePrefix = (
  input: Readonly<{ retirement: SnapshotArtifactRetirementInput; prefix: string }>
): Effect.Effect<SnapshotArtifactRetirementStatus, SnapshotUnavailable> =>
  Effect.gen(function* () {
    yield* authorize(input.retirement);
    const page = yield* artifactIo(() =>
      input.retirement.artifacts.list({ prefix: input.prefix, limit: pageSize })
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Page)));
    const keys = page.objects.map((object) => object.key);
    if (keys.some((key) => !key.startsWith(input.prefix))) return yield* new SnapshotUnavailable();
    if (keys.length === 0) {
      if (page.truncated) return yield* new SnapshotUnavailable();
      return { complete: true, deleted: 0 };
    }
    yield* authorize(input.retirement);
    yield* artifactIo(() => input.retirement.artifacts.delete(keys));
    // A subsequent invocation observes emptiness; never advance a cursor over keys just deleted.
    return { complete: false, deleted: keys.length };
  }).pipe(Effect.mapError(() => new SnapshotUnavailable()));
export const retireArtifacts = (
  input: SnapshotArtifactRetirementInput
): Effect.Effect<SnapshotArtifactRetirementStatus, SnapshotUnavailable> =>
  Effect.gen(function* () {
    yield* authorize(input);
    const scope = yield* artifactScope(input);
    let complete = true;
    let deleted = 0;
    for (const section of ["pages", "objects", "jobs"]) {
      const result = yield* retirePrefix({
        retirement: input,
        prefix: `recovery/sqlite-snapshots/${section}/${scope}/`,
      });
      complete = complete && result.complete;
      deleted += result.deleted;
    }
    yield* authorize(input);
    return { complete, deleted };
  }).pipe(Effect.catchCause(() => Effect.fail(new SnapshotUnavailable())));
