import * as Alchemist from "alchemy/Alchemist";
import { describePlan } from "alchemy/Plan";
import { Config, Effect, Schema } from "effect";
import {
  nativePlanOptions,
  requireSuccessorLifecycle,
  successorPlanSelection,
} from "./native-fixture-plan";
import { expectedFixtureSigner } from "./native-fixture-signer";
import { diagnoseNativePlan } from "./native-plan-diagnostics";
import { requireSuccessorPlanBindings } from "./storage-installation";

const Source = Schema.Struct({
  revision: Schema.String,
  previousRevision: Schema.Literal("0ba692ff68c1d63da1f4a7fdb8d6df5ff1566287"),
  previousRelease: Schema.Literal("14645515552"),
  previousCleanup: Schema.Literal("14656121411"),
  signerSha256: Schema.String,
});
const plan = Effect.gen(function* () {
  yield* Config.Literal("true", "GITHUB_ACTIONS");
  yield* Config.Literal("true", "GITHUB_REF_PROTECTED");
  yield* Config.Literal("refs/heads/trunk", "GITHUB_REF");
  yield* Config.Literal("workflow_dispatch", "GITHUB_EVENT_NAME");
  yield* Config.Literal("1", "GITHUB_RUN_ATTEMPT");
  yield* Config.Literal("plan-fixture-successor", "FIXTURE_RELEASE_OPERATION");
  yield* Config.Literal("closed", "NATIVE_STORAGE_ADMISSION");
  yield* Config.Literal("acceptance", "NATIVE_STORAGE_HOSTS");
  yield* Config.Literal(
    "B4rz99/fidy-ai/.github/workflows/native-fixture-successor-plan.yml@refs/heads/trunk",
    "GITHUB_WORKFLOW_REF"
  );
  const revision = yield* Config.String("RELEASE_GIT_SHA");
  const fingerprint = yield* expectedFixtureSigner;
  const directory = yield* Config.String("RUNNER_TEMP");
  const raw = yield* Effect.tryPromise(() =>
    Bun.file(directory + "/fixture-successor-source.json").json()
  );
  const source = yield* Schema.decodeUnknownEffect(Source)(raw);
  if (
    !/^[a-f0-9]{40}$/u.test(revision) ||
    !/^[a-f0-9]{64}$/u.test(fingerprint) ||
    source.signerSha256 !== fingerprint ||
    source.revision !== revision ||
    source.previousRevision === revision
  ) {
    return yield* Effect.fail(Error("Unqualified closed successor plan source"));
  }
  const profile = yield* Config.String("ALCHEMY_PROFILE");
  const snapshot = yield* Alchemist.Stack.plan({
    ...nativePlanOptions({ profile, preview: true, fingerprint }),
    include: successorPlanSelection(revision),
  }).pipe(diagnoseNativePlan(revision));
  const observed = describePlan(snapshot.native);
  if (snapshot.native.selectedFqns === undefined || observed.actions.length !== 0) {
    return yield* Effect.fail(Error("Successor inventory requires a scoped read-only plan"));
  }
  yield* Effect.try(() => {
    requireSuccessorLifecycle({ rows: observed.resources, revision });
    requireSuccessorPlanBindings({ plan: snapshot.native, revision, fingerprint });
  });
  const resources = observed.resources.map(({ logicalId, resourceType, action }) => ({
    logicalId,
    resourceType,
    action,
  }));
  yield* Effect.tryPromise(() =>
    Bun.write(
      directory + "/native-fixture-successor-plan.json",
      JSON.stringify({ ...source, member: "performance-2", applied: false, resources })
    )
  );
});

if (import.meta.main) {
  await Effect.runPromise(plan.pipe(Effect.provide(Alchemist.layer()), Effect.scoped)).catch(() => {
    process.stderr.write("Closed fixture successor plan refused\n");
    process.exitCode = 1;
  });
}
