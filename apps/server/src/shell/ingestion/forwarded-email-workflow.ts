import {
  Cause,
  Config,
  DateTime,
  Effect,
  Array as EffectArray,
  Exit,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import {
  EntityAddress,
  EntityId,
  EntityType,
  MessageStorage,
  Sharding,
} from "effect/unstable/cluster";
import { Activity, DurableClock } from "effect/unstable/workflow";
import type { UserId } from "~/core/identity/reference";
import type { ForwardedEmailProviderFailureReason } from "~/core/ingestion/rules";
import type { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { durableQueueRetention } from "~/shell/durable-execution-retention";
import {
  type ForwardedEmailReceiptLifecycle,
  activateDeferredForwardedEmail,
  completeForwardedEmailCleanup,
  findExpiredForwardedEmailExecutions,
  findForwardedEmailReceiptLifecycle,
  findPendingForwardedEmailExecutions,
  forwardedEmailRecoveryPageSize,
  markForwardedEmailCleanupChecked,
  resolveForwardedEmailUser,
  startForwardedEmailCleanup,
} from "./email-forwarding-repo";
import {
  ForwardedEmailRetrievalFailed,
  ForwardedEmailWorkerConfigLive,
  forwardedEmailTerminalOutcome,
  interpretForwardedEmail,
  retrieveForwardedEmail,
  settleForwardedEmail,
  settleForwardedEmailRetrievalFailure,
} from "./email-worker";
import {
  ForwardedEmailWorkflow,
  type ForwardedEmailWorkflowPayload,
  forwardedEmailQueueId,
  forwardedEmailQueueName,
  forwardedEmailWorkflowQueue,
} from "./forwarded-email-execution";

export { ForwardedEmailWorkflow, ForwardedEmailWorkflowPayload } from "./forwarded-email-execution";

const TerminalActivityOutcome = Schema.Union([
  Schema.TaggedStruct("Completed", {}),
  Schema.TaggedStruct("Revoked", {}),
  Schema.TaggedStruct("Expired", {}),
  Schema.TaggedStruct("Stale", {}),
]);
const AccessOutcome = Schema.Union([
  Schema.TaggedStruct("Ready", {}),
  Schema.TaggedStruct("Deferred", { resumeAt: Schema.DateTimeUtcFromString }),
  TerminalActivityOutcome,
]);
const RetrievalOutcome = Schema.Union([
  Schema.TaggedStruct("Retrieved", {}),
  Schema.TaggedStruct("ConsentDeferred", {}),
  TerminalActivityOutcome,
]);
const consentAwareTerminalOutcomes = [
  "consent-deferred",
  "completed",
  "revoked",
  "expired",
  "stale",
  "evidence-expired",
] as const;
const InterpretationOutcome = Schema.Struct({
  outcome: Schema.Literals(["prepared", ...consentAwareTerminalOutcomes]),
});
const SettlementOutcome = Schema.Struct({
  outcome: Schema.Literals(consentAwareTerminalOutcomes),
});

const terminalAccessOutcome = (
  access: Exclude<typeof AccessOutcome.Type, { readonly _tag: "Ready" | "Deferred" }>
): "completed" | "revoked" | "expired" | "stale" =>
  access._tag === "Stale" ? "stale" : forwardedEmailTerminalOutcome(access._tag);

const maximumProviderRetries = 2;
const workflowEntityType = `Workflow/${ForwardedEmailWorkflow.name}`;

const accessFromLifecycle = (
  lifecycle: ForwardedEmailReceiptLifecycle
): typeof AccessOutcome.Type => {
  if (lifecycle._tag !== "Actionable") return { _tag: lifecycle._tag } as const;
  return lifecycle.context.status === "accepted"
    ? ({ _tag: "Ready" } as const)
    : ({
        _tag: "Deferred",
        resumeAt: Option.getOrThrow(lifecycle.context.resumeAt),
      } as const);
};

const transitionAccess = Effect.fn("ForwardedEmail.transitionAccess")(function* (
  payload: ForwardedEmailWorkflowPayload,
  validateRouting: boolean
) {
  if (validateRouting) {
    const owner = yield* resolveForwardedEmailUser(payload.receivedEmailId);
    if (Option.isNone(owner) || owner.value !== payload.userId) return { _tag: "Stale" as const };
  }
  const lifecycle = yield* findForwardedEmailReceiptLifecycle(
    payload.userId,
    payload.receivedEmailId
  );
  if (Option.isNone(lifecycle)) return { _tag: "Stale" as const };
  if (lifecycle.value._tag !== "Actionable" || lifecycle.value.context.status === "accepted") {
    return accessFromLifecycle(lifecycle.value);
  }
  yield* activateDeferredForwardedEmail(lifecycle.value.context, yield* DateTime.now);
  const transitioned = yield* findForwardedEmailReceiptLifecycle(
    payload.userId,
    payload.receivedEmailId
  );
  return Option.isSome(transitioned)
    ? accessFromLifecycle(transitioned.value)
    : { _tag: "Stale" as const };
});

const inspectAccess = Effect.fn("ForwardedEmail.inspectAccess")(
  (payload: ForwardedEmailWorkflowPayload) => transitionAccess(payload, true)
);

const resumeAccess = Effect.fn("ForwardedEmail.resumeAccess")(
  (payload: ForwardedEmailWorkflowPayload) => transitionAccess(payload, false)
);

const waitForConsent = Effect.fn("ForwardedEmail.waitForConsent")(function* (
  name:
    | "WaitForForwardedEmailRetrievalConsent"
    | "WaitForForwardedEmailInterpretationConsent"
    | "WaitForForwardedEmailSettlementConsent",
  attempt: number
) {
  yield* DurableClock.sleep({ name: `${name}/${attempt}`, duration: "1 day" });
});

const awaitForwardedEmailAccess = Effect.fn("ForwardedEmail.awaitAccess")(function* (
  payload: ForwardedEmailWorkflowPayload
) {
  let access = yield* Activity.make({
    name: "ApplyForwardedEmailAccess",
    success: AccessOutcome,
    execute: inspectAccess(payload),
  });
  let attempt = 1;
  while (access._tag === "Deferred") {
    const currentAttempt = attempt++;
    const now = yield* DateTime.now;
    yield* DurableClock.sleep({
      name: `WaitForForwardedEmailAllowance/${currentAttempt}`,
      duration: DateTime.distance(now, access.resumeAt),
    });
    access = yield* Activity.make({
      name: "ResumeForwardedEmailAccess",
      success: AccessOutcome,
      execute: resumeAccess(payload),
    }).pipe(Effect.provideService(Activity.CurrentAttempt, currentAttempt));
  }
  return access;
});

const resumeForwardedEmailAfterConsentWait = Effect.fn("ForwardedEmail.resumeAfterConsentWait")(
  function* (input: {
    readonly payload: ForwardedEmailWorkflowPayload;
    readonly initialAttempt: number;
    readonly activityName:
      | "ResumeForwardedEmailRetrievalConsent"
      | "ResumeForwardedEmailInterpretationConsent"
      | "ResumeForwardedEmailSettlementConsent";
    readonly clockName:
      | "WaitForForwardedEmailRetrievalConsentAllowance"
      | "WaitForForwardedEmailInterpretationConsentAllowance"
      | "WaitForForwardedEmailSettlementConsentAllowance";
  }) {
    const { activityName, clockName, payload } = input;
    let attempt = input.initialAttempt;
    let access = yield* Activity.make({
      name: activityName,
      success: AccessOutcome,
      execute: resumeAccess(payload),
    }).pipe(Effect.provideService(Activity.CurrentAttempt, attempt++));
    while (access._tag === "Deferred") {
      const currentAttempt = attempt++;
      const now = yield* DateTime.now;
      yield* DurableClock.sleep({
        name: `${clockName}/${currentAttempt}`,
        duration: DateTime.distance(now, access.resumeAt),
      });
      access = yield* Activity.make({
        name: activityName,
        success: AccessOutcome,
        execute: resumeAccess(payload),
      }).pipe(Effect.provideService(Activity.CurrentAttempt, currentAttempt));
    }
    return { access, attempt };
  }
);

const retrieveUntilConsentAvailable = Effect.fn("ForwardedEmail.retrieveUntilConsent")(function* (
  payload: ForwardedEmailWorkflowPayload,
  initialAttempt: number
) {
  let attempt = initialAttempt;
  let retrieval;
  let providerRetries = 0;
  let consentResumeAttempt = 1;
  for (;;) {
    const currentAttempt = attempt++;
    retrieval = yield* Effect.result(
      Activity.make({
        name: "RetrieveForwardedEmail",
        success: RetrievalOutcome,
        error: ForwardedEmailRetrievalFailed,
        execute: retrieveForwardedEmail(payload),
      }).pipe(Effect.provideService(Activity.CurrentAttempt, currentAttempt))
    );
    if (
      Result.isFailure(retrieval) &&
      retrieval.failure.reason === "provider-unavailable" &&
      providerRetries++ < maximumProviderRetries
    ) {
      yield* Effect.logWarning("Forwarded email provider activity will retry").pipe(
        Effect.annotateLogs({
          activity_name: "RetrieveForwardedEmail",
          attempt: providerRetries,
          retryable: true,
          work_kind: "forwarded-email-ingestion",
        })
      );
      continue;
    }
    if (Result.isFailure(retrieval) || retrieval.success._tag !== "ConsentDeferred") break;
    providerRetries = 0;
    yield* waitForConsent("WaitForForwardedEmailRetrievalConsent", currentAttempt);
    const resumed = yield* resumeForwardedEmailAfterConsentWait({
      payload,
      initialAttempt: consentResumeAttempt,
      activityName: "ResumeForwardedEmailRetrievalConsent",
      clockName: "WaitForForwardedEmailRetrievalConsentAllowance",
    });
    consentResumeAttempt = resumed.attempt;
    if (resumed.access._tag !== "Ready") {
      retrieval = Result.succeed({ _tag: resumed.access._tag });
      break;
    }
  }
  return { attempt, retrieval };
});

const repeatConsentAwareActivity = Effect.fn("ForwardedEmail.repeatConsentAwareActivity")(
  function* <Outcome extends string, R>(input: {
    readonly payload: ForwardedEmailWorkflowPayload;
    readonly initialAttempt: number;
    readonly waitName:
      | "WaitForForwardedEmailInterpretationConsent"
      | "WaitForForwardedEmailSettlementConsent";
    readonly resumeActivityName:
      | "ResumeForwardedEmailInterpretationConsent"
      | "ResumeForwardedEmailSettlementConsent";
    readonly resumeClockName:
      | "WaitForForwardedEmailInterpretationConsentAllowance"
      | "WaitForForwardedEmailSettlementConsentAllowance";
    readonly execute: (
      attempt: number
    ) => Effect.Effect<Readonly<{ outcome: Outcome | "consent-deferred" }>, never, R>;
  }) {
    let attempt = input.initialAttempt;
    let consentResumeAttempt = 1;
    for (;;) {
      const currentAttempt = attempt++;
      const result = yield* input.execute(currentAttempt);
      if (result.outcome !== "consent-deferred") return { attempt, outcome: result.outcome };
      yield* waitForConsent(input.waitName, currentAttempt);
      const resumed = yield* resumeForwardedEmailAfterConsentWait({
        payload: input.payload,
        initialAttempt: consentResumeAttempt,
        activityName: input.resumeActivityName,
        clockName: input.resumeClockName,
      });
      consentResumeAttempt = resumed.attempt;
      if (resumed.access._tag !== "Ready") {
        return { attempt, outcome: terminalAccessOutcome(resumed.access) };
      }
    }
  }
);

const interpretUntilConsentAvailable = Effect.fn("ForwardedEmail.interpretUntilConsent")(
  (payload: ForwardedEmailWorkflowPayload, initialAttempt: number) =>
    repeatConsentAwareActivity({
      payload,
      initialAttempt,
      waitName: "WaitForForwardedEmailInterpretationConsent",
      resumeActivityName: "ResumeForwardedEmailInterpretationConsent",
      resumeClockName: "WaitForForwardedEmailInterpretationConsentAllowance",
      execute: (currentAttempt) =>
        Activity.make({
          name: "InterpretForwardedEmail",
          success: InterpretationOutcome,
          execute: interpretForwardedEmail(payload),
        }).pipe(Effect.provideService(Activity.CurrentAttempt, currentAttempt)),
    })
);

const settleUntilConsentAvailable = Effect.fn("ForwardedEmail.settleUntilConsent")(
  (
    payload: ForwardedEmailWorkflowPayload,
    initialAttempt: number,
    retrievalFailure: Option.Option<ForwardedEmailProviderFailureReason>
  ) =>
    repeatConsentAwareActivity({
      payload,
      initialAttempt,
      waitName: "WaitForForwardedEmailSettlementConsent",
      resumeActivityName: "ResumeForwardedEmailSettlementConsent",
      resumeClockName: "WaitForForwardedEmailSettlementConsentAllowance",
      execute: (currentAttempt) =>
        Activity.make({
          name: Option.isSome(retrievalFailure)
            ? "SettleForwardedEmailRetrievalFailure"
            : "SettleForwardedEmail",
          success: SettlementOutcome,
          execute: Option.isSome(retrievalFailure)
            ? settleForwardedEmailRetrievalFailure(payload, retrievalFailure.value)
            : settleForwardedEmail(payload),
        }).pipe(Effect.provideService(Activity.CurrentAttempt, currentAttempt)),
    })
);

const executeForwardedEmailEvidenceCycle = Effect.fn("ForwardedEmail.executeEvidenceCycle")(
  function* (payload: ForwardedEmailWorkflowPayload, initialAttempt: number) {
    const retrievalStep = yield* retrieveUntilConsentAvailable(payload, initialAttempt);
    const { attempt, retrieval } = retrievalStep;
    if (Result.isFailure(retrieval)) {
      const settled = yield* settleUntilConsentAvailable(
        payload,
        attempt,
        Option.some(retrieval.failure.reason)
      );
      return settled.outcome === "evidence-expired"
        ? { _tag: "Repeat" as const, attempt: settled.attempt }
        : { _tag: "Done" as const, outcome: settled.outcome };
    }
    if (retrieval.success._tag !== "Retrieved") {
      if (retrieval.success._tag === "ConsentDeferred") {
        return yield* Effect.die(new Error("Unresolved Consent deferral escaped retrieval loop"));
      }
      return { _tag: "Done" as const, outcome: terminalAccessOutcome(retrieval.success) };
    }
    const interpreted = yield* interpretUntilConsentAvailable(payload, attempt);
    if (interpreted.outcome === "evidence-expired") {
      return { _tag: "Repeat" as const, attempt: interpreted.attempt };
    }
    if (interpreted.outcome !== "prepared") {
      return { _tag: "Done" as const, outcome: interpreted.outcome };
    }
    const settled = yield* settleUntilConsentAvailable(payload, interpreted.attempt, Option.none());
    return settled.outcome === "evidence-expired"
      ? { _tag: "Repeat" as const, attempt: settled.attempt }
      : { _tag: "Done" as const, outcome: settled.outcome };
  }
);

const runForwardedEmailWorkflow = Effect.fn("ForwardedEmail.run")(function* (
  payload: ForwardedEmailWorkflowPayload
) {
  const access = yield* awaitForwardedEmailAccess(payload);
  if (access._tag !== "Ready") return { outcome: terminalAccessOutcome(access) };

  let attempt = 1;
  for (;;) {
    const cycle = yield* executeForwardedEmailEvidenceCycle(payload, attempt);
    if (cycle._tag === "Done") return { outcome: cycle.outcome };
    attempt = cycle.attempt;
  }
});

const observeForwardedEmailWorkflow = Effect.fn("ForwardedEmail.observeWorkflow")(
  (payload: ForwardedEmailWorkflowPayload) =>
    runForwardedEmailWorkflow(payload).pipe(
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
        const outcome = Exit.isSuccess(exit) ? exit.value.outcome : "failed";
        const log = Exit.isSuccess(exit) ? Effect.logInfo : Effect.logError;
        return log("Forwarded email durable Work finished").pipe(
          Effect.annotateLogs({ outcome, work_kind: "forwarded-email-ingestion" })
        );
      })
    )
);

/** Registers all schema-backed forwarded-email Activities with the workflow engine. */
export const ForwardedEmailWorkflowLive = ForwardedEmailWorkflow.toLayer(
  observeForwardedEmailWorkflow
).pipe(Layer.provide(ForwardedEmailWorkerConfigLive));

/** Clears one bounded, terminality-proved page after the evidence replay horizon. */
export const retainForwardedEmailExecutions = Effect.fn("ForwardedEmail.retainExecutions")(
  function* (input: { readonly now: DateTime.Utc; readonly retentionDays: number }) {
    const expired = yield* findExpiredForwardedEmailExecutions(
      DateTime.subtract(input.now, { days: input.retentionDays })
    );
    const storage = yield* MessageStorage.MessageStorage;
    const sharding = yield* Sharding.Sharding;
    const candidates = yield* Effect.forEach(expired, (candidate) =>
      Effect.gen(function* () {
        const { receivedEmailId, userId } = candidate;
        const payload = { userId, receivedEmailId, revision: 1 as const };
        const executionId = yield* ForwardedEmailWorkflow.executionId(payload);
        if (Option.isNone(candidate.cleanupStartedAt)) {
          const execution = yield* ForwardedEmailWorkflow.poll(executionId);
          if (Option.isNone(execution) || execution.value._tag !== "Complete") {
            yield* markForwardedEmailCleanupChecked({ ...candidate, observedAt: input.now });
            return Option.none();
          }
          if (!(yield* startForwardedEmailCleanup({ ...candidate, observedAt: input.now }))) {
            return Option.none();
          }
        }
        const entityId = EntityId.make(executionId);
        return Option.some({
          ...candidate,
          queueId: yield* forwardedEmailQueueId(payload),
          address: EntityAddress.make({
            entityId,
            entityType: EntityType.make(workflowEntityType),
            shardId: sharding.getShardId(entityId, "default"),
          }),
        });
      }).pipe(Effect.orDie)
    );
    const terminal = EffectArray.getSomes(candidates);
    const clearedQueueIds = terminal.map(({ queueId }) => queueId);
    yield* durableQueueRetention.removeCompleted(forwardedEmailQueueName, clearedQueueIds);
    yield* Effect.forEach(
      terminal,
      (candidate) =>
        storage
          .clearAddress(candidate.address)
          .pipe(
            Effect.andThen(completeForwardedEmailCleanup({ ...candidate, observedAt: input.now })),
            Effect.orDie
          ),
      { discard: true }
    );
    if (expired.length === 100) {
      yield* Effect.logWarning("Forwarded email durable retention reached its bounded page limit");
    }
    return clearedQueueIds.length;
  }
);

const executeForwardedEmailHandoff = Effect.fn("ForwardedEmail.executeHandoff")(function* (
  payload: ForwardedEmailWorkflowPayload,
  queueId: string,
  discard: boolean = false
) {
  if ((yield* forwardedEmailQueueId(payload)) !== queueId) return { outcome: "stale" as const };
  if (discard) {
    yield* ForwardedEmailWorkflow.execute(payload, { discard: true });
    return { outcome: "submitted" as const };
  }
  return yield* ForwardedEmailWorkflow.execute(payload);
});

/** Skips stale or malformed durable entries until one current receipt settles or the seam times out. */
export const processNextCurrentForwardedEmail = Effect.fn("ForwardedEmail.processNextCurrent")(
  function* () {
    const queue = yield* forwardedEmailWorkflowQueue;
    const takeCurrent = queue.take((payload, { id }) => executeForwardedEmailHandoff(payload, id));
    const completed = yield* Effect.gen(function* () {
      for (;;) {
        const result = yield* Effect.result(takeCurrent);
        if (Result.isSuccess(result) && result.success.outcome !== "stale") return true;
      }
    }).pipe(Effect.timeoutOption("2 seconds"));
    return Option.getOrElse(completed, () => false);
  }
);

type RecoveryCursor = ResendReceivedEmailId;

const publishRecoveredForwardedEmail = Effect.fn("ForwardedEmail.publishRecovered")(
  function* (input: { readonly userId: UserId; readonly receivedEmailId: ResendReceivedEmailId }) {
    const queue = yield* forwardedEmailWorkflowQueue;
    const payload = { ...input, revision: 1 as const };
    yield* queue.offer(payload, { id: yield* forwardedEmailQueueId(payload) }).pipe(Effect.orDie);
  }
);

/** Starts native consumers and performs one finite, paced startup recovery sweep. */
export const ForwardedEmailQueueLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") return;
    const queue = yield* forwardedEmailWorkflowQueue;
    const publishPage = Effect.fn("ForwardedEmail.publishPage")(function* (
      cursor: Option.Option<RecoveryCursor>
    ) {
      const pending = yield* findPendingForwardedEmailExecutions(cursor);
      yield* Effect.forEach(pending, publishRecoveredForwardedEmail, { discard: true });
      return pending.length === forwardedEmailRecoveryPageSize
        ? Option.fromUndefinedOr(pending.at(-1)?.receivedEmailId)
        : Option.none<ResendReceivedEmailId>();
    });
    const firstPage = yield* publishPage(Option.none());
    yield* queue
      .take((payload, { id }) =>
        executeForwardedEmailHandoff(payload, id, true).pipe(
          Effect.tapCause(() => Effect.logError("Forwarded email workflow execution failed safely"))
        )
      )
      .pipe(
        Effect.catchCause(() =>
          Effect.logError("Forwarded email queue entry failed validation").pipe(
            Effect.andThen(Effect.sleep("1 second"))
          )
        ),
        Effect.forever,
        Effect.forkScoped
      );
    if (Option.isSome(firstPage)) {
      yield* Effect.gen(function* () {
        let cursor: Option.Option<RecoveryCursor> = firstPage;
        while (Option.isSome(cursor)) {
          yield* Effect.sleep("1 minute");
          cursor = yield* publishPage(cursor);
        }
      }).pipe(Effect.forkScoped);
    }
  })
);
