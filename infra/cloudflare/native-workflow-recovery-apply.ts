import { isDeepStrictEqual } from "node:util";
import * as Alchemist from "alchemy/Alchemist";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { State } from "alchemy/State";
import { Config, Effect, ManagedRuntime, Schema } from "effect";
import { applyScopedNativePlan } from "./native-fixture-plan";
import { diagnoseSuccessorApply } from "./native-plan-diagnostics";
import {
  WorkflowPlanEvidence,
  WorkflowRecoveryRefused,
  instanceProof,
  interruptedRevision,
  readQualifiedWorkflowPlan,
  smokeName,
  workflowId,
  workflowRecoveryFailureMessage,
} from "./native-workflow-recovery-plan";
import { releaseCommand, releaseEvidence } from "./production-release";

type Evidence = typeof WorkflowPlanEvidence.Type;

export const requireSameWorkflowPlan = (input: {
  approved: Evidence;
  observed: Evidence;
}): void => {
  if (!isDeepStrictEqual(input.approved, input.observed)) {
    throw new WorkflowRecoveryRefused({
      message: "Approved Workflow scope or tracked state changed",
    });
  }
};

const StateRow = Schema.Struct({
  status: Schema.Literal("created"),
  fqn: Schema.Literal(workflowId),
  logicalId: Schema.Literal(workflowId),
  resourceType: Schema.Literal("Cloudflare.Workflow"),
  instanceId: Schema.NonEmptyString,
  attr: Schema.Struct({
    accountId: Schema.String,
    workflowId: Schema.String.check(
      Schema.isPattern(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/u)
    ),
    workflowName: Schema.Literal(smokeName),
    className: Schema.Literal("ReleaseSmokeWorkflowV2"),
    scriptName: Schema.Literal(smokeName),
    schedules: Schema.Tuple([]),
  }),
});

const PendingState = Schema.Struct({
  status: Schema.Literal("creating"),
  fqn: Schema.Literal(workflowId),
  logicalId: Schema.Literal(workflowId),
  resourceType: Schema.Literal("Cloudflare.Workflow"),
  instanceId: Schema.NonEmptyString,
  attr: Schema.optional(Schema.Undefined),
});

export const confirmAppliedWorkflow = (input: {
  raw: unknown;
  account: string;
  approvedInstance: string;
}): string => {
  const row = Schema.decodeUnknownSync(StateRow)(input.raw);

  if (
    row.attr.accountId !== input.account ||
    instanceProof(row.instanceId) !== input.approvedInstance
  ) {
    throw new WorkflowRecoveryRefused({
      message: "Applied Workflow does not own the approved state instance",
    });
  }

  return row.attr.workflowId;
};

const persistedWorkflow = Effect.gen(function* () {
  const state = yield* yield* State;
  const stack = yield* Stack;
  const stage = yield* Stage;

  return yield* state.get({ stack: stack.name, stage, fqn: workflowId });
});

const applyWorkflowRecovery = Effect.fn("applyWorkflowRecovery")(function* () {
  yield* Config.Literal(
    "B4rz99/fidy-ai/.github/workflows/native-fixture-workflow-recovery-apply.yml@refs/heads/trunk",
    "GITHUB_WORKFLOW_REF"
  );
  const { snapshot, evidence, directory } = yield* readQualifiedWorkflowPlan();

  const approved = yield* Schema.decodeUnknownEffect(WorkflowPlanEvidence, {
    onExcessProperty: "error",
  })(yield* releaseEvidence.readFile(directory + "/native-workflow-recovery-approved.json"));

  yield* Effect.try(() => requireSameWorkflowPlan({ approved, observed: evidence }));
  const account = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
  const workspace = yield* Config.String("GITHUB_WORKSPACE");
  yield* releaseCommand({
    args: [
      "python3",
      workspace + "/scripts/infra-performance/canonical-fixture/successor_partial.py",
    ],
    lifetime: "read-only",
  });

  const pending = yield* Schema.decodeUnknownEffect(PendingState)(
    yield* persistedWorkflow.pipe(Effect.provide(snapshot.session.context))
  );

  if (instanceProof(pending.instanceId) !== approved.instanceProof) {
    return yield* new WorkflowRecoveryRefused({
      message: "Tracked Workflow instance changed before apply",
    });
  }

  const raw = yield* applyScopedNativePlan(snapshot.native).pipe(
    diagnoseSuccessorApply(interruptedRevision),
    Effect.andThen(persistedWorkflow),
    Effect.provide(snapshot.session.context),
    Effect.uninterruptible
  );

  const workflow = yield* Effect.try(() =>
    confirmAppliedWorkflow({ raw, account, approvedInstance: approved.instanceProof })
  );

  yield* releaseEvidence.writeFile(
    directory + "/native-workflow-recovery-state.json",
    releaseEvidence.encodeJson({
      verifierRevision: approved.verifierRevision,
      candidateRevision: approved.candidateRevision,
      stateProof: approved.stateProof,
      instanceProof: approved.instanceProof,
      workflowId: workflow,
    })
  );
});

if (import.meta.main) {
  const runtime = ManagedRuntime.make(Alchemist.layer());

  try {
    await runtime.runPromise(
      applyWorkflowRecovery().pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            process.stderr.write(workflowRecoveryFailureMessage(cause) + "\n");
            process.exitCode = 1;
          })
        )
      )
    );
  } finally {
    await runtime.dispose();
  }
}
