import { RecoveryProviderTarget } from "./recovery-provider-contract";
import { type RecoveryProbeIdentity, verifyRecoveryRuntime } from "./recovery-runtime-proof";
import { Data, Effect, Option, Schema } from "effect";

class RecoveryProviderUnavailable extends Data.TaggedError("RecoveryProviderUnavailable")<{
  message: string;
}> {}

const Namespaces = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(
    Schema.Struct({
      id: RecoveryProviderTarget.fields.namespaceId,
      script: RecoveryProviderTarget.fields.owner,
      class: RecoveryProviderTarget.fields.owner,
      use_sqlite: Schema.Boolean,
    })
  ),
});
const Binding = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  namespace_id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});
const TargetVersion = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: RecoveryProviderTarget.fields.version,
    resources: Schema.Struct({ bindings: Schema.Array(Binding) }),
  }),
});
const Subdomain = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ enabled: Schema.Boolean, previews_enabled: Schema.Boolean }),
});
const Routes = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(Schema.Unknown),
});
const Schedules = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ schedules: Schema.Array(Schema.Unknown) }),
});
const Deployments = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    deployments: Schema.Array(
      Schema.Struct({
        id: RecoveryProviderTarget.fields.version,
        versions: Schema.Array(
          Schema.Struct({
            version_id: RecoveryProviderTarget.fields.version,
            percentage: Schema.Finite,
          })
        ),
      })
    ),
  }),
});
const refusal = (): Effect.Effect<never, Error> =>
  Effect.fail(
    new RecoveryProviderUnavailable({
      message: "Recovery provider identity or isolation is unverified",
    })
  );
type Read = (path: string) => Effect.Effect<unknown, Error>;
const requireBinding = (
  bindings: ReadonlyArray<typeof Binding.Type>,
  name: string,
  value: string
): boolean => {
  const matches = bindings.filter((binding) => binding.name === name);
  return matches.length === 1 && matches[0]?.type === "plain_text" && matches[0].text === value;
};
const requireVersion = (
  input: Readonly<{ target: RecoveryProviderTarget; revision: string; read: Read }>
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const version = yield* Schema.decodeUnknownEffect(TargetVersion)(
      yield* input.read(`/workers/scripts/${input.target.owner}/versions/${input.target.version}`)
    );
    const bindings = version.result.resources.bindings;
    const namespace = bindings.filter(
      (binding) =>
        binding.type === "durable_object_namespace" &&
        binding.namespace_id === input.target.namespaceId
    );
    if (version.result.id !== input.target.version || namespace.length !== 1) {
      return yield* refusal();
    }
    const required = [
      { name: "SQLITE_STORE_NAMESPACE_ID", value: input.target.namespaceId },
      { name: "SQLITE_STORE_MANIFEST", value: input.target.manifest },
      { name: "SQLITE_STORE_EPOCH", value: input.target.epoch },
      { name: "RELEASE_GIT_SHA", value: input.revision },
    ];
    const metadata = bindings.filter((binding) => binding.name === "CF_VERSION_METADATA");
    if (metadata.length !== 1 || metadata[0]?.type !== "version_metadata") return yield* refusal();
    if (!required.every(({ name, value }) => requireBinding(bindings, name, value))) {
      return yield* refusal();
    }
  }).pipe(
    Effect.mapError(
      () =>
        new RecoveryProviderUnavailable({
          message: "Recovery immutable target binding is unverified",
        })
    )
  );
const requireDeployment = (
  input: Readonly<{ target: RecoveryProviderTarget; read: Read }>
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const base = `/workers/scripts/${input.target.owner}`;
    const deployments = yield* Schema.decodeUnknownEffect(Deployments)(
      yield* input.read(`${base}/deployments`)
    );
    const current = Option.fromUndefinedOr(deployments.result.deployments[0]);
    if (
      Option.isNone(current) ||
      current.value.versions.length !== 1 ||
      current.value.versions[0]?.version_id !== input.target.version ||
      current.value.versions[0].percentage !== 100
    ) {
      return yield* refusal();
    }
    return current.value.id;
  });

const requireIsolation = (
  input: Readonly<{ target: RecoveryProviderTarget; read: Read }>
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const base = `/workers/scripts/${input.target.owner}`;
    const routes = yield* Schema.decodeUnknownEffect(Routes)(yield* input.read(`${base}/routes`));
    const subdomain = yield* Schema.decodeUnknownEffect(Subdomain)(
      yield* input.read(`${base}/subdomain`)
    );
    const schedules = yield* Schema.decodeUnknownEffect(Schedules)(
      yield* input.read(`${base}/schedules`)
    );
    if (
      routes.result.length !== 0 ||
      subdomain.result.enabled ||
      subdomain.result.previews_enabled ||
      schedules.result.schedules.length !== 0
    ) {
      return yield* refusal();
    }
    return yield* requireDeployment(input);
  }).pipe(
    Effect.mapError(
      () =>
        new RecoveryProviderUnavailable({
          message: "Recovery target routing or schedules are unverified",
        })
    )
  );

/** Observes one isolated target through platform UUIDs and immutable bindings. This is not admission, background, history, replay or activation qualification. */
export const inspectRecoveryNamespace = (
  input: Readonly<{
    target: RecoveryProviderTarget;
    revision: string;
    read: Read;
    probe: RecoveryProbeIdentity;
    readRuntime: Effect.Effect<unknown, Error>;
  }>
): Effect.Effect<
  Readonly<{
    target: RecoveryProviderTarget;
    deploymentId: string;
    observation: "TargetBindingsObserved";
    probe: RecoveryProbeIdentity;
    objectName: "authoritative-v1";
  }>,
  Error
> =>
  Effect.gen(function* () {
    const target = yield* Schema.decodeEffect(RecoveryProviderTarget)(input.target);
    const namespaces = yield* Schema.decodeUnknownEffect(Namespaces)(
      yield* input.read("/workers/durable_objects/namespaces")
    );
    const matches = namespaces.result.filter((namespace) => namespace.id === target.namespaceId);
    if (
      matches.length !== 1 ||
      matches[0]?.script !== target.owner ||
      matches[0].class !== target.className ||
      !matches[0].use_sqlite
    ) {
      return yield* refusal();
    }
    yield* requireVersion({ ...input, target });
    yield* verifyRecoveryRuntime(input);
    const deploymentId = yield* requireIsolation({ ...input, target });
    return {
      target,
      deploymentId,
      observation: "TargetBindingsObserved" as const,
      probe: input.probe,
      objectName: "authoritative-v1" as const,
    };
  }).pipe(
    Effect.mapError(
      () => new RecoveryProviderUnavailable({ message: "Recovery provider observation refused" })
    )
  );
