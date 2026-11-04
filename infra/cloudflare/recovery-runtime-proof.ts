import { RecoveryStoreObservation } from "../../apps/server/cloudflare/recovery-activation/contract";
import { Data, Effect, Schema } from "effect";
import { RecoveryProviderTarget } from "./recovery-provider-contract";

export type RecoveryProbeIdentity = Readonly<{ name: string; version: string; binding: string }>;
class RecoveryRuntimeUnverified extends Data.TaggedError("RecoveryRuntimeUnverified") {}
const RuntimeProof = Schema.Struct({
  callerVersion: RecoveryProviderTarget.fields.version,
  objectName: Schema.Literal("authoritative-v1"),
  expectedObjectId: RecoveryProviderTarget.fields.objectId,
  store: Schema.Struct({
    ...RecoveryStoreObservation.fields,
    ownerVersion: RecoveryProviderTarget.fields.version,
  }),
});
const Caller = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: RecoveryProviderTarget.fields.version,
    resources: Schema.Struct({
      bindings: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          type: Schema.String,
          namespace_id: Schema.optional(Schema.String),
        })
      ),
    }),
  }),
});

type RuntimeProof = typeof RuntimeProof.Type;
type CallerVersion = (typeof Caller.Type)["result"];
const matchesCaller = (
  input: Readonly<{
    caller: CallerVersion;
    probe: RecoveryProbeIdentity;
    target: RecoveryProviderTarget;
  }>
): boolean => {
  const selected = input.caller.resources.bindings.filter(
    (binding) => binding.name === input.probe.binding
  );
  const metadata = input.caller.resources.bindings.filter(
    (binding) => binding.name === "CF_VERSION_METADATA"
  );
  return (
    input.caller.id === input.probe.version &&
    selected.length === 1 &&
    selected[0]?.type === "durable_object_namespace" &&
    selected[0].namespace_id === input.target.namespaceId &&
    metadata.length === 1 &&
    metadata[0]?.type === "version_metadata"
  );
};
const matchesTarget = (
  input: Readonly<{ target: RecoveryProviderTarget; observed: RuntimeProof["store"]["target"] }>
): boolean =>
  input.target.namespaceId === input.observed.namespaceId &&
  input.target.manifest === input.observed.manifest &&
  input.target.epoch === input.observed.epoch;
const matchesRuntime = (
  input: Readonly<{
    proof: RuntimeProof;
    target: RecoveryProviderTarget;
    probe: RecoveryProbeIdentity;
  }>
): boolean =>
  input.proof.callerVersion === input.probe.version &&
  input.proof.store.ownerVersion === input.target.version &&
  input.proof.expectedObjectId === input.target.objectId &&
  input.proof.store.target.objectId === input.proof.expectedObjectId &&
  matchesTarget({ target: input.target, observed: input.proof.store.target });

/** Read runtime identity only through the reviewed metadata probe. */
export const verifyRecoveryRuntime = (
  input: Readonly<{
    target: RecoveryProviderTarget;
    probe: RecoveryProbeIdentity;
    read: (path: string) => Effect.Effect<unknown, Error>;
    readRuntime: Effect.Effect<unknown, Error>;
  }>
): Effect.Effect<void, RecoveryRuntimeUnverified> =>
  Effect.gen(function* () {
    const caller = yield* Schema.decodeUnknownEffect(Caller)(
      yield* input.read(
        `/workers/scripts/${encodeURIComponent(input.probe.name)}/versions/${encodeURIComponent(input.probe.version)}`
      )
    );
    if (!matchesCaller({ caller: caller.result, target: input.target, probe: input.probe })) {
      return yield* new RecoveryRuntimeUnverified();
    }
    const proof = yield* Schema.decodeUnknownEffect(RuntimeProof, { onExcessProperty: "error" })(
      yield* input.readRuntime
    );
    if (!matchesRuntime({ proof, target: input.target, probe: input.probe })) {
      return yield* new RecoveryRuntimeUnverified();
    }
  }).pipe(Effect.mapError(() => new RecoveryRuntimeUnverified()));
