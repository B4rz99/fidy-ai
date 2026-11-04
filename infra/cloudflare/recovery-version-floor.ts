import { Effect, Schema } from "effect";

const maximumRetirements = 4;
const maximumEligibleVersions = 100;
const Version = Schema.String.check(Schema.isUUID());
export const RecoveryVersionFloorWorker = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/u)),
  workerId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  version: Version,
});
export type RecoveryVersionFloorWorker = typeof RecoveryVersionFloorWorker.Type;
const Identity = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: RecoveryVersionFloorWorker.fields.workerId,
    name: RecoveryVersionFloorWorker.fields.name,
  }),
});
const Eligible = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Version })) }),
});
const Deployment = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    deployments: Schema.Array(
      Schema.Struct({
        id: Version,
        versions: Schema.Array(Schema.Struct({ version_id: Version, percentage: Schema.Finite })),
      })
    ),
  }),
});
const Removed = Schema.Struct({ success: Schema.Literal(true) });
type Read = (path: string) => Effect.Effect<unknown, Error>;
const requireCurrent = (
  input: Readonly<{ worker: RecoveryVersionFloorWorker; read: Read }>
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const deployment = yield* Schema.decodeUnknownEffect(Deployment)(
      yield* input.read(`/workers/scripts/${input.worker.name}/deployments`)
    );
    const versions = deployment.result.deployments[0]?.versions;
    if (
      versions?.length !== 1 ||
      versions[0]?.version_id !== input.worker.version ||
      versions[0].percentage !== 100
    ) {
      return yield* Effect.fail(Error("Recovery deployment floor changed"));
    }
  });
const eligibleVersions = (
  input: Readonly<{ worker: RecoveryVersionFloorWorker; read: Read }>
): Effect.Effect<ReadonlyArray<string>, Error> =>
  Effect.gen(function* () {
    // Cloudflare's deployable filter returns the complete eligible set and ignores pagination.
    const response = yield* Schema.decodeUnknownEffect(Eligible)(
      yield* input.read(`/workers/scripts/${input.worker.name}/versions?deployable=true`)
    );
    const eligible = response.result.items.map((item) => item.id);
    if (
      eligible.length === 0 ||
      eligible.length >= maximumEligibleVersions ||
      new Set(eligible).size !== eligible.length ||
      !eligible.includes(input.worker.version)
    ) {
      return yield* Effect.fail(Error("Recovery eligible version inventory unavailable"));
    }
    return eligible;
  });

/** Must run under serialized release authority. Version retirement does not establish native or provider work drain. */
export const retireRecoveryVersionFloor = (
  input: Readonly<{
    worker: RecoveryVersionFloorWorker;
    read: Read;
    remove: (path: string) => Effect.Effect<unknown, Error>;
  }>
): Effect.Effect<
  Readonly<{
    worker: RecoveryVersionFloorWorker;
    state: "EligibleVersionsRetired" | "Retiring";
    eligible: ReadonlyArray<string>;
  }>,
  Error
> =>
  Effect.gen(function* () {
    const worker = yield* Schema.decodeEffect(RecoveryVersionFloorWorker)(input.worker);
    const identity = yield* Schema.decodeUnknownEffect(Identity)(
      yield* input.read(`/workers/workers/${worker.workerId}`)
    );
    if (identity.result.id !== worker.workerId || identity.result.name !== worker.name) {
      return yield* Effect.fail(Error("Recovery Worker identity mismatch"));
    }
    yield* requireCurrent({ ...input, worker });
    const before = yield* eligibleVersions({ ...input, worker });
    const retire = before
      .filter((version) => version !== worker.version)
      .slice(0, maximumRetirements);
    for (const version of retire) {
      yield* requireCurrent({ ...input, worker });
      yield* Schema.decodeUnknownEffect(Removed)(
        yield* input.remove(`/workers/workers/${worker.workerId}/versions/${version}`)
      );
    }
    const eligible = yield* eligibleVersions({ ...input, worker });
    yield* requireCurrent({ ...input, worker });
    return {
      worker,
      state: eligible.length === 1 ? ("EligibleVersionsRetired" as const) : ("Retiring" as const),
      eligible,
    };
  }).pipe(
    Effect.mapError(() => Error("Recovery version retirement unverified; inspect provider state"))
  );
