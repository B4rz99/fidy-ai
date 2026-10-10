import { Effect, Schema } from "effect";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import { type Deployment, type ReleaseSnapshot } from "./release-controller";

// Land and deploy the code-only prerequisite before the retention migration. If it is squash
// merged, replace this with that reviewed immutable commit; never use trunk or an environment flag.
export const retentionCompatibilityRevision = "84ff69c0d9b8007547bcaea48172cff622e6f548";

const RevisionBinding = Schema.Struct({
  type: Schema.Literal("plain_text"),
  text: SmokeIdentity.fields.gitRevision,
});
const NamedBinding = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  text: Schema.optional(Schema.String),
});
const Version = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: SmokeIdentity.fields.workerVersionId,
    resources: Schema.Struct({
      bindings: Schema.Union([
        Schema.Array(NamedBinding),
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    }),
  }),
});

/** Resolve source from the exact immutable Worker version, never from mutable Worker settings. */
export const decodeRetentionVersionRevision = ({
  raw,
  expectedId,
}: Readonly<{ raw: unknown; expectedId: string }>): string => {
  const version = Schema.decodeUnknownSync(Version)(raw).result;
  if (version.id !== expectedId) throw Error("Retention Worker version identity changed");
  const bindings = version.resources.bindings;
  const matches = Schema.is(Schema.Array(NamedBinding))(bindings)
    ? bindings.filter((binding) => binding.name === "RELEASE_GIT_SHA")
    : [bindings["RELEASE_GIT_SHA"]];
  if (matches.length !== 1) throw Error("Retention Worker source revision is ambiguous");
  return Schema.decodeUnknownSync(RevisionBinding)(matches[0]).text;
};

export type RetentionCompatibilityPort = Readonly<{
  current(name: string): Effect.Effect<Deployment, Error>;
  revision(name: string, versionId: string): Effect.Effect<string, Error>;
  requireCompatible(revision: string): Effect.Effect<void, Error>;
}>;

/** The sole supported rollback target is the captured stable Core version. */
export const requireRetentionRollback = Effect.fn(function* (
  port: RetentionCompatibilityPort,
  snapshot: ReleaseSnapshot
) {
  const revision = yield* port.revision(snapshot.core.name, snapshot.core.stableVersionId);
  if (revision !== snapshot.stableRevision) {
    return yield* Effect.fail(Error("Retention rollback source identity changed"));
  }
  yield* port.requireCompatible(revision);
});

const requireCapturedCore = Effect.fn(function* (
  port: RetentionCompatibilityPort,
  snapshot: ReleaseSnapshot
) {
  const current = yield* port.current(snapshot.core.name);
  if (
    current.id !== snapshot.core.deploymentId ||
    current.versions.length !== 1 ||
    current.versions[0]?.id !== snapshot.core.stableVersionId ||
    current.versions[0].percentage !== 100
  ) {
    return yield* Effect.fail(
      Error("Retention migration requires the captured stable Core deployment")
    );
  }
});

/** Fail closed before D1 apply: every traffic-serving version and guarded rollback target is proven. */
export const requireRetentionMigration = Effect.fn(function* (
  port: RetentionCompatibilityPort,
  snapshot: ReleaseSnapshot
) {
  yield* requireCapturedCore(port, snapshot);
  yield* requireRetentionRollback(port, snapshot);
  yield* port.requireCompatible(snapshot.revision);
  yield* requireCapturedCore(port, snapshot);
});
