import { Effect, Option, Schedule, Schema } from "effect";
import { ErasureReference } from "../../apps/server/src/core/erasure/contract";
import { type UserObjects, physicalErasure } from "./native-erasure-evidence";

const objectId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

const Marker = Schema.Struct({
  stage: Schema.String,
  populated: Schema.optional(Schema.Int),
  observations: Schema.optional(Schema.Int),
  listed: Schema.optional(Schema.Int),
  physicalObject: Schema.optional(objectId),
  reference: Schema.optional(ErasureReference),
});

const Checkpoint = Schema.Struct({
  stage: Schema.Literal("waiting-physical-erasure"),
  revision: Schema.String,
  userNamespace: Schema.String,
  checkpoints: Schema.Array(Marker),
});

const commitment = (ids: ReadonlyArray<string>): string =>
  new Bun.CryptoHasher("sha256").update([...ids].sort().join("\n")).digest("hex");

export type ErasureProgress = (
  stage:
    | "physical-empty"
    | "physical-absent"
    | "survivors-matched"
    | "erased-provider-verified"
    | "completion-invalid"
    | "completion-unavailable"
    | "pairing-pending"
    | "pairing-expired"
    | "physical-rechecked"
) => Effect.Effect<void, Error>;

export type ErasureContinuation = {
  checkpoint: unknown;
  revision: string;
  userNamespace: string;
  baseline: string;
  survivors: string;
  inventory: () => Effect.Effect<UserObjects, Error>;
  renew: () => Effect.Effect<void, Error>;
  logins: () => Effect.Effect<ReadonlyArray<string>, Error>;
  record: ErasureProgress;
  refused: (record: ErasureProgress) => Effect.Effect<"invalid" | "unavailable", Error>;
};

const readAdmission = Effect.fn(function* (input: ErasureContinuation) {
  const checkpoint = yield* Schema.decodeUnknownEffect(Checkpoint)(input.checkpoint);
  const markers = checkpoint.checkpoints;
  const required = ["stable-users", "signup-created", "fresh-object", "admitted"];

  const [, , fresh, admission] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([
      Schema.Struct({ stage: Schema.Literal("stable-users"), populated: Schema.Literal(3) }),
      Schema.Struct({ stage: Schema.Literal("signup-created") }),
      Schema.Struct({ stage: Schema.Literal("fresh-object"), physicalObject: objectId }),
      Schema.Struct({
        stage: Schema.Literal("admitted"),
        physicalObject: objectId,
        reference: ErasureReference,
      }),
    ])
  )(markers.filter((row) => required.includes(row.stage)));

  const admittedIndex = markers.findIndex((row) => row.stage === "admitted");

  const replay = markers
    .slice(admittedIndex + 1)
    .some(
      (row) =>
        row.stage === "waiting-physical-erasure" &&
        (row.observations ?? 0) > 0 &&
        row.listed === 4 &&
        row.populated === 4
    );

  if (
    checkpoint.revision !== input.revision ||
    checkpoint.userNamespace !== input.userNamespace ||
    fresh.physicalObject !== admission.physicalObject ||
    !replay
  ) {
    return yield* Effect.fail(Error("Unbound admitted checkpoint"));
  }

  return { target: admission.physicalObject, reference: admission.reference };
});

type Stage =
  | "admitted checkpoint"
  | "work lease"
  | "namespace census"
  | "retained physical identities"
  | "physical transition"
  | "survivor identities"
  | "erased provider login";

const step = <A>(stage: Stage, task: Effect.Effect<A, Error>): Effect.Effect<A, Error> =>
  task.pipe(Effect.tapError(() => Effect.logError("Erasure continuation failed at " + stage)));

const repeatSafe = <A>(
  stage: Stage,
  read: () => Effect.Effect<A, Error>
): Effect.Effect<A, Error> =>
  step(
    stage,
    Effect.suspend(read).pipe(
      Effect.timeout("15 seconds"),
      Effect.retry({ times: 2, schedule: Schedule.spaced("2 seconds") })
    )
  );

const retainedObjects = Effect.fn(function* (
  current: UserObjects,
  target: string,
  baseline: string
) {
  const retained = new Map(current);
  retained.delete(target);

  if (
    retained.size !== 3 ||
    [...retained.values()].some((value) => !value) ||
    commitment([...retained.keys()]) !== baseline
  ) {
    return yield* step(
      "retained physical identities",
      Effect.fail(Error("Retained physical identity mismatch"))
    );
  }

  return retained;
});

export const continueAdmittedErasure = Effect.fn(function* (input: ErasureContinuation) {
  const { target, reference } = yield* step("admitted checkpoint", readAdmission(input));

  const census = (): Effect.Effect<UserObjects, Error> =>
    repeatSafe("namespace census", input.inventory);

  const current = yield* census();
  const retained = yield* retainedObjects(current, target, input.baseline);

  const state = (rows: UserObjects): Effect.Effect<ReturnType<typeof physicalErasure>, Error> =>
    Effect.try(() => physicalErasure({ before: retained, subject: target, current: rows }));

  const advance = Effect.gen(function* () {
    yield* repeatSafe("work lease", input.renew);
    const rows = yield* census();
    yield* Effect.logInfo("Erasure continuation census listed " + rows.size);

    return yield* state(rows);
  });

  const waitForErasure = step(
    "physical transition",
    advance.pipe(
      Effect.repeat({ while: Option.isNone, schedule: Schedule.spaced("30 seconds") }),
      Effect.timeout("20 minutes"),
      Effect.flatMap((value) => Effect.fromOption(value, () => Error("Erasure transition missing")))
    )
  );

  const result = yield* Option.match(yield* state(current), {
    onSome: Effect.succeed,
    onNone: () => waitForErasure,
  });

  yield* input.record(result === "empty" ? "physical-empty" : "physical-absent");
  const ids = yield* step("survivor identities", input.logins());

  if (ids.length !== 2 || new Set(ids).size !== 2 || commitment(ids) !== input.survivors) {
    return yield* step(
      "survivor identities",
      Effect.fail(Error("Original survivor identities differ"))
    );
  }

  yield* input.record("survivors-matched");
  const providerCompletion = yield* step("erased provider login", input.refused(input.record));
  yield* step(
    "physical transition",
    state(yield* census()).pipe(
      Effect.flatMap((value) => Effect.fromOption(value, () => Error("Physical erasure regressed")))
    )
  );
  yield* input.record("physical-rechecked");

  return {
    reference,
    physicalObject: target,
    physicalStateBefore: "stored",
    physicalStateAfter: result,
    admissionReplay: "same-reference",
    survivingUsers: ids.length,
    survivorIdentitySet: "matched",
    providerCompletion,
    erasedProviderPairing: "pending-then-expired-without-session",
    originalBrowserSessionDenial: "unavailable",
    custodianCompletion: "unverified",
    recoveryWindow: "pending",
  } as const;
});
