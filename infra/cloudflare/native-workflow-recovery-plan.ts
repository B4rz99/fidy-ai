import { isDeepStrictEqual } from "node:util";
import * as Alchemist from "alchemy/Alchemist";
import type { Plan } from "alchemy/Plan";
import {
  Cause,
  Config,
  Data,
  Effect,
  ManagedRuntime,
  Option,
  Path,
  Predicate,
  Schema,
} from "effect";
import { nativeResourceInventory } from "./native-graph";
import { readNativeScopedPlan } from "./native-storage-resources";
import { releaseEvidence } from "./production-release";
import { nativeResourceFailureMessage } from "./resource-failure";

export const interruptedRevision = "de04a192c3836be0efb488b170a7b93b9f98f28f";

export const workflowId = "ReleaseSmokeWorkflowV2-" + interruptedRevision;

const hostId = "ReleaseSmoke-" + interruptedRevision;

export const smokeName = "fidy-native-smoke-" + interruptedRevision;

const workflowType = "Cloudflare.Workflow";

export class WorkflowRecoveryRefused extends Data.TaggedError("WorkflowRecoveryRefused")<{
  message: string;
}> {}

const isWorkflowRecoveryRefused = (value: unknown): value is WorkflowRecoveryRefused =>
  Predicate.isTagged(value, "WorkflowRecoveryRefused");

const WorkflowProperties = Schema.Struct({
  workflowName: Schema.Literal(smokeName),
  className: Schema.Literal("ReleaseSmokeWorkflowV2"),
  scriptName: Schema.optional(Schema.Literal(smokeName)),
  limits: Schema.optional(Schema.Undefined),
  schedules: Schema.optional(Schema.Tuple([])),
});

const WorkflowBinding = Schema.Struct({ scriptName: Schema.Literal(smokeName) });

const SmokeAttributes = Schema.Struct({ workerName: Schema.Literal(smokeName) });

const RecoveryNode = Schema.Struct({
  action: Schema.String,
  resource: Schema.Struct({
    LogicalId: Schema.String,
    Type: Schema.String,
    RemovalPolicy: Schema.optional(Schema.String),
  }),
  bindings: Schema.Array(Schema.Struct({ data: Schema.Unknown })),
  downstream: Schema.Array(Schema.String),
  renamedFrom: Schema.optional(Schema.Array(Schema.String)),
  deferredAdoption: Schema.optional(Schema.Struct({ adopt: Schema.Boolean })),
  props: Schema.optional(Schema.Unknown),
  state: Schema.optional(
    Schema.Struct({
      status: Schema.String,
      logicalId: Schema.String,
      fqn: Schema.String,
      resourceType: Schema.String,
      instanceId: Schema.String,
      attr: Schema.optional(Schema.Unknown),
      props: Schema.optional(Schema.Unknown),
      removalPolicy: Schema.optional(Schema.String),
      downstream: Schema.optional(Schema.Array(Schema.String)),
    })
  ),
});

type Node = typeof RecoveryNode.Type;

type WorkflowPlan = Pick<
  Plan,
  "destroy" | "selectedFqns" | "cycleMembers" | "deletions" | "actions" | "actionDeletions"
> & {
  resources: Readonly<Record<string, Node>>;
};

const InterruptedRow = Schema.Struct({
  status: Schema.Literal("creating"),
  logicalId: Schema.Literal(workflowId),
  resourceType: Schema.Literal(workflowType),
  instanceId: Schema.NonEmptyString,
  attr: Schema.optional(Schema.Undefined),
  props: WorkflowProperties,
});

const exactProperties = Schema.decodeUnknownOption(WorkflowProperties, {
  onExcessProperty: "error",
});

const workflowNodeIsInterrupted = (node: Node): boolean =>
  node.action === "create" &&
  Schema.is(InterruptedRow)(node.state) &&
  node.deferredAdoption?.adopt !== true &&
  Option.isSome(exactProperties(node.state.props)) &&
  Option.isSome(exactProperties(node.props)) &&
  Schema.is(Schema.Tuple([Schema.Struct({ data: WorkflowBinding })]))(node.bindings);

const metadataMatches = (node: Node): boolean => {
  const state = node.state;

  return (
    state?.resourceType === node.resource.Type &&
    state.removalPolicy === node.resource.RemovalPolicy &&
    isDeepStrictEqual(new Set(state.downstream), new Set(node.downstream))
  );
};

const ReviewedAction = Schema.Literals(["create", "update", "noop", "replace", "adopted"]);

const resourceLabel = (node: Node): string => {
  const action = Option.getOrElse(
    Schema.decodeUnknownOption(ReviewedAction)(node.action),
    () => "unknown action"
  );

  return " [" + node.resource.LogicalId + ", " + action + "]";
};

const requireScopedNodes = (plan: WorkflowPlan): ReadonlySet<string> => {
  const selected = plan.selectedFqns;

  if (
    selected === undefined ||
    selected.size !== Object.keys(plan.resources).length ||
    plan.destroy === true ||
    [plan.actions, plan.deletions, plan.actionDeletions].some(
      (rows) => Object.keys(rows).length !== 0
    ) ||
    plan.cycleMembers.size !== 0
  ) {
    throw new WorkflowRecoveryRefused({
      message: "Workflow recovery requires a scoped acyclic plan without actions or deletions",
    });
  }

  return selected;
};

const requireNoopResource = (node: Node): void => {
  if (node.action !== "noop" || !metadataMatches(node)) {
    throw new WorkflowRecoveryRefused({
      message:
        "Workflow recovery would change an upstream resource or its state metadata" +
        resourceLabel(node),
    });
  }

  if (node.resource.LogicalId === hostId && !Schema.is(SmokeAttributes)(node.state?.attr)) {
    throw new WorkflowRecoveryRefused({
      message: "Workflow recovery targets another Smoke host" + resourceLabel(node),
    });
  }
};

const requireResourceState = (fqn: string, node: Node): void => {
  if (node.state?.fqn !== fqn) {
    throw new WorkflowRecoveryRefused({
      message: "Workflow recovery scope changed its state identity" + resourceLabel(node),
    });
  }

  if (node.resource.LogicalId !== workflowId) {
    return requireNoopResource(node);
  }

  if (!workflowNodeIsInterrupted(node)) {
    throw new WorkflowRecoveryRefused({
      message: "Missing exact interrupted Workflow state" + resourceLabel(node),
    });
  }
};

const acceptScopedNode = ({
  selected,
  inventory,
  approved,
  fqn,
  node,
}: {
  selected: ReadonlySet<string>;
  inventory: ReadonlyMap<string, string>;
  approved: ReadonlySet<string>;
  fqn: string;
  node: Node;
}): boolean =>
  selected.has(fqn) &&
  inventory.get(node.resource.LogicalId) === node.resource.Type &&
  !approved.has(node.resource.LogicalId) &&
  (node.renamedFrom?.length ?? 0) === 0;

export const qualifyWorkflowRecoveryPlan = (plan: WorkflowPlan): readonly string[] => {
  const selected = requireScopedNodes(plan);
  const inventory = nativeResourceInventory(interruptedRevision);
  const approved = new Set<string>();

  for (const [fqn, node] of Object.entries(plan.resources)) {
    if (!acceptScopedNode({ selected, inventory, approved, fqn, node })) {
      throw new WorkflowRecoveryRefused({
        message: "Workflow recovery scope contains an unexpected resource or migration",
      });
    }

    requireResourceState(fqn, node);
    approved.add(node.resource.LogicalId);
  }

  if (!approved.delete(workflowId) || !approved.has(hostId)) {
    throw new WorkflowRecoveryRefused({
      message: "Workflow recovery is missing the interrupted Workflow or exact host",
    });
  }

  return [...approved].toSorted((left, right) => left.localeCompare(right));
};

const ReviewedPartial = Schema.Struct({
  verifierRevision: Schema.String,
  candidateRevision: Schema.Literal(interruptedRevision),
  failedRun: Schema.Literal("44806738835"),
  planRun: Schema.Literal("44806470332"),
  applied: Schema.Literal(false),
  recoveryReady: Schema.Literal(false),
  candidateTraffic: Schema.Literal(0),
  missing: Schema.Tuple([Schema.Literal("Smoke Workflow")]),
  rawProtocolReadersOverlap: Schema.Literal(false),
  compatibilityReviewRevision: Schema.Literal("b5b4b8149af0aad6cbd5d6f657c949d03d1f5e7d"),
});

const ProofDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

export const WorkflowPlanEvidence = Schema.Struct({
  ...ReviewedPartial.fields,
  change: Schema.Struct({
    logicalId: Schema.Literal(workflowId),
    resourceType: Schema.Literal(workflowType),
    action: Schema.Literal("create"),
  }),
  unchanged: Schema.Tuple([
    Schema.Literal(hostId),
    Schema.Literal("ReleaseSmokeBucket"),
    Schema.Literal("ReleaseSmokeQueue-" + interruptedRevision),
  ]),
  stateProof: ProofDigest,
  instanceProof: ProofDigest,
});

export const instanceProof = (id: string): string =>
  new Bun.CryptoHasher("sha256").update(id).digest("hex");

const stateProof = (plan: WorkflowPlan): string =>
  instanceProof(
    releaseEvidence.encodeJson(
      Object.entries(plan.resources)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([fqn, node]) => [
          fqn,
          node.action,
          node.state?.instanceId,
          node.state?.status,
          node.state?.resourceType,
          node.state?.removalPolicy,
          [...node.downstream].toSorted((left, right) => left.localeCompare(right)),
        ])
    )
  );

const requireProtectedInvocation = Effect.gen(function* () {
  yield* Config.Literal("true", "GITHUB_ACTIONS");
  yield* Config.Literal("true", "GITHUB_REF_PROTECTED");
  yield* Config.Literal("refs/heads/trunk", "GITHUB_REF");
  yield* Config.Literal("workflow_dispatch", "GITHUB_EVENT_NAME");
  yield* Config.Literal("1", "GITHUB_RUN_ATTEMPT");
  yield* Config.Literal("closed", "NATIVE_STORAGE_ADMISSION");
  yield* Config.Literal("acceptance", "NATIVE_STORAGE_HOSTS");
  yield* Config.Literal("stage-fixture-successor", "FIXTURE_RELEASE_OPERATION");
  yield* Config.Literal(interruptedRevision, "RELEASE_GIT_SHA");
  yield* Config.Literal("44806738835-1", "RELEASE_ATTEMPT_ID");
});

export const readQualifiedWorkflowPlan = Effect.fn("readQualifiedWorkflowPlan")(function* () {
  yield* requireProtectedInvocation;
  const verifierRevision = yield* Config.String("GITHUB_SHA");
  const path = yield* Path.Path;
  const workspace = yield* Config.String("GITHUB_WORKSPACE");
  const directory = yield* Config.String("RUNNER_TEMP");
  const fingerprint = yield* Config.String("NATIVE_FIXTURE_SIGNER_SHA256");
  const profile = yield* Config.String("ALCHEMY_PROFILE");

  const reviewed = yield* Schema.decodeUnknownEffect(ReviewedPartial, {
    onExcessProperty: "error",
  })(yield* releaseEvidence.readFile(directory + "/native-fixture-successor-partial.json"));

  if (
    reviewed.verifierRevision !== verifierRevision ||
    !/^[a-f0-9]{40}$/u.test(verifierRevision) ||
    !/^[a-f0-9]{64}$/u.test(fingerprint) ||
    process.cwd() !== path.resolve(workspace, "interrupted/infra/cloudflare")
  ) {
    return yield* new WorkflowRecoveryRefused({
      message: "Unexpected interrupted application checkout or read-only proof",
    });
  }

  const snapshot = yield* readNativeScopedPlan({
    profile,
    fingerprint,
    revision: interruptedRevision,
    include: [workflowId],
  });

  const unchanged = yield* Effect.try({
    try: () => qualifyWorkflowRecoveryPlan(snapshot.native),
    catch: (error) =>
      isWorkflowRecoveryRefused(error)
        ? error
        : new WorkflowRecoveryRefused({
            message: "Unexpected Workflow plan qualification failure",
          }),
  });

  const row = snapshot.native.resources[workflowId]?.state;

  if (row === undefined) {
    return yield* new WorkflowRecoveryRefused({ message: "The tracked Workflow FQN differs" });
  }

  const evidence = yield* Schema.decodeUnknownEffect(WorkflowPlanEvidence)({
    ...reviewed,
    change: { logicalId: workflowId, resourceType: workflowType, action: "create" },
    unchanged,
    stateProof: stateProof(snapshot.native),
    instanceProof: instanceProof(row.instanceId),
  });

  return { snapshot, evidence, directory };
});

export const workflowRecoveryFailureMessage = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause);

  return Option.isSome(failure) && isWorkflowRecoveryRefused(failure.value)
    ? failure.value.message
    : nativeResourceFailureMessage(cause);
};

const readWorkflowRecoveryPlan = Effect.gen(function* () {
  yield* Config.Literal(
    "B4rz99/fidy-ai/.github/workflows/native-fixture-workflow-recovery-plan.yml@refs/heads/trunk",
    "GITHUB_WORKFLOW_REF"
  );
  const { evidence, directory } = yield* readQualifiedWorkflowPlan();
  yield* releaseEvidence.writeFile(
    directory + "/native-workflow-recovery-plan.json",
    releaseEvidence.encodeJson(evidence)
  );
});

if (import.meta.main) {
  const runtime = ManagedRuntime.make(Alchemist.layer());

  try {
    await runtime.runPromise(
      readWorkflowRecoveryPlan.pipe(
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
