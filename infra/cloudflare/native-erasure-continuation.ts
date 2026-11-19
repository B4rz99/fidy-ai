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
export type ErasureContinuation = {
  checkpoint: unknown;
  revision: string;
  userNamespace: string;
  baseline: string;
  survivors: string;
  inventory: () => Effect.Effect<UserObjects, Error>;
  renew: () => Effect.Effect<void, Error>;
  logins: () => Effect.Effect<ReadonlyArray<string>, Error>;
  refused: () => Effect.Effect<void, Error>;
};

const readAdmission = Effect.fn(function* (input: ErasureContinuation) {
  const checkpoint = yield* Schema.decodeUnknownEffect(Checkpoint)(input.checkpoint);
  const markers = checkpoint.checkpoints;
  const required = ["stable-users", "signup-created", "fresh-object", "admitted"];
  const [,, fresh, admission] = yield* Schema.decodeUnknownEffect(Schema.Tuple([
    Schema.Struct({ stage: Schema.Literal("stable-users"), populated: Schema.Literal(3) }),
    Schema.Struct({ stage: Schema.Literal("signup-created") }),
    Schema.Struct({ stage: Schema.Literal("fresh-object"), physicalObject: objectId }),
    Schema.Struct({ stage: Schema.Literal("admitted"), physicalObject: objectId, reference: ErasureReference }),
  ]))(markers.filter((row) => required.includes(row.stage)));
  const admittedIndex = markers.findIndex((row) => row.stage === "admitted");
  const replay = markers.slice(admittedIndex + 1).some((row) =>
    row.stage === "waiting-physical-erasure" && (row.observations ?? 0) > 0 &&
    row.listed === 4 && row.populated === 4);
  if (checkpoint.revision !== input.revision || checkpoint.userNamespace !== input.userNamespace ||
      fresh.physicalObject !== admission.physicalObject || !replay) {
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
    Effect.suspend(read).pipe(Effect.timeout("15 seconds"), Effect.retry({ times: 2, schedule: Schedule.spaced("2 seconds") }))
  );

export const continueAdmittedErasure = Effect.fn(function* (input: ErasureContinuation) {
  const { target, reference } = yield* step("admitted checkpoint", readAdmission(input));
  const census = (): Effect.Effect<UserObjects, Error> => repeatSafe("namespace census", input.inventory);
  const current = yield* census();
  const retained = new Map(current);
  retained.delete(target);
  if (
    retained.size !== 3 ||
    [...retained.values()].some((value) => !value) ||
    commitment([...retained.keys()]) !== input.baseline
  ) {
    return yield* step(
      "retained physical identities",
      Effect.fail(Error("Retained physical identity mismatch"))
    );
  }
  const state = (rows: UserObjects): Effect.Effect<ReturnType<typeof physicalErasure>, Error> =>
    Effect.try(() => physicalErasure({ before: retained, subject: target, current: rows }));
  const advance = Effect.gen(function* () {
    yield* repeatSafe("work lease", input.renew);
    const rows = yield* census();
    yield* Effect.logInfo("Erasure continuation census listed " + rows.size);
    return yield* state(rows);
  });
  const result = yield* step(
    "physical transition",
    advance.pipe(
      Effect.repeat({ while: Option.isNone, schedule: Schedule.spaced("30 seconds") }),
      Effect.timeout("20 minutes"),
      Effect.flatMap((value) => Effect.fromOption(value, () => Error("Erasure transition missing")))
    )
  );
  const ids = yield* step("survivor identities", input.logins());
  if (ids.length !== 2 || new Set(ids).size !== 2 || commitment(ids) !== input.survivors) {
    return yield* step(
      "survivor identities",
      Effect.fail(Error("Original survivor identities differ"))
    );
  }
  yield* step("erased provider login", input.refused());
  yield* step(
    "physical transition",
    state(yield* census()).pipe(
      Effect.flatMap((value) => Effect.fromOption(value, () => Error("Physical erasure regressed")))
    )
  );
  return {
    reference,
    physicalObject: target,
    physicalStateBefore: "stored",
    physicalStateAfter: result,
    admissionReplay: "same-reference",
    survivingUsers: ids.length,
    survivorIdentitySet: "matched",
    erasedProviderLogin: "refused",
    originalBrowserSessionDenial: "unavailable",
    custodianCompletion: "unverified",
    recoveryWindow: "pending",
  } as const;
});
