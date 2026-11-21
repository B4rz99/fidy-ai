import { sanitizeWorkTrace, workTraceHeaders } from "../../runtime/telemetry/operations";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { Cause, Data, Effect, Exit, Option, Ref, Schema } from "effect";
import {
  StatementCoordinatorActivity,
  StatementDeliveryUnavailable,
  StatementWork,
  type StatementWorkflow,
  statementWorkflowRetention as retention,
} from "../contract";
import { maximumStatementChunkActivities } from "./statement-processing-limits";

const Work = StatementWork;

const CoordinatorWork = StatementCoordinatorActivity;

const coordinatorActivity = Data.taggedEnum<typeof CoordinatorWork.Type>();

const WorkflowState = Schema.Struct({
  status: Schema.Literals([
    "queued",
    "running",
    "paused",
    "errored",
    "terminated",
    "complete",
    "waiting",
    "waitingForPause",
    "rollingBack",
    "unknown",
  ]),
});

const attempt = <A>(run: () => PromiseLike<A>): Effect.Effect<A, StatementDeliveryUnavailable> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new StatementDeliveryUnavailable({ cause }),
  });

export const isStatementExtractionWork = (body: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(Work)(body));

const missingWorkStatus = 404;

type MessagePage = ReadonlyArray<Readonly<{ body: unknown; ack: () => void }>>;

const handoffStatements = (input: {
  workflow: StatementWorkflow;
  messages: MessagePage;
  pending: (work: typeof Work.Type) => Effect.Effect<boolean, StatementDeliveryUnavailable>;
  reconcile: (work: typeof Work.Type) => Effect.Effect<void, StatementDeliveryUnavailable>;
}): Effect.Effect<void, StatementDeliveryUnavailable> =>
  Effect.forEach(
    input.messages,
    Effect.fnUntraced(function* (message) {
      const work = Schema.decodeUnknownOption(Work)(message.body);

      if (Option.isNone(work)) {
        message.ack();

        return;
      }

      if (!(yield* input.pending(work.value))) {
        message.ack();

        return;
      }

      const params = yield* sanitizeWorkTrace(work.value);

      const started = yield* Effect.exit(
        attempt(() =>
          input.workflow.create({
            id: work.value.submissionId,
            params,
            retention,
          })
        )
      );

      if (Exit.isFailure(started)) {
        if (Cause.hasInterrupts(started.cause)) return yield* Effect.failCause(started.cause);
        yield* input.reconcile(work.value);
      }

      message.ack();
    }),
    { discard: true }
  ).pipe(Effect.withSpan("ingestion.statementReceive"));

export const receiveNativeStatementExtraction = (input: {
  environment: {
    USER_STORE: StatementCoordinator;
    STATEMENT_EXTRACTION_WORKFLOW: StatementWorkflow;
  };
  messages: MessagePage;
}): Effect.Effect<void, StatementDeliveryUnavailable> => {
  const { USER_STORE: users, STATEMENT_EXTRACTION_WORKFLOW: workflow } = input.environment;

  return handoffStatements({
    messages: input.messages,
    workflow,
    pending: (work) =>
      Effect.gen(function* () {
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Work))(work).pipe(
          Effect.mapError((cause) => new StatementDeliveryUnavailable({ cause }))
        );

        const response = yield* attempt(() =>
          users
            .getByName(work.userId)
            .fetch("https://user.invalid/ingestion/statement/pending", { method: "POST", body })
        );

        if (response.status === missingWorkStatus) return false;

        if (!response.ok) {
          return yield* new StatementDeliveryUnavailable({ cause: "statement_owner" });
        }

        return true;
      }),
    reconcile: (work) =>
      Effect.gen(function* () {
        const state = yield* workflowState(workflow, work.submissionId);

        if (["errored", "terminated", "complete"].includes(state.status)) {
          const owner = users;
          yield* attempt(() => coordinatedStatementStep(owner, work, "StatementFailed"));
        }
      }),
  });
};

type StatementCoordinator = Readonly<{
  getByName: (name: string) => Pick<Fetcher, "fetch">;
}>;

const workflowState = (
  workflow: Pick<StatementWorkflow, "get">,
  id: string
): Effect.Effect<typeof WorkflowState.Type, StatementDeliveryUnavailable> =>
  Effect.gen(function* () {
    const instance = yield* attempt(() => workflow.get(id));

    const statusMethod =
      typeof instance === "object" && instance !== null && "status" in instance
        ? instance.status
        : undefined;

    if (typeof statusMethod !== "function") {
      return yield* new StatementDeliveryUnavailable({ cause: "Workflow status unavailable" });
    }

    const status = yield* attempt(() => {
      const result: unknown = statusMethod.call(instance);

      return Promise.resolve(result);
    });

    return yield* Schema.decodeUnknownEffect(WorkflowState)(status).pipe(
      Effect.mapError((cause) => new StatementDeliveryUnavailable({ cause }))
    );
  });

type Activity = <A extends boolean>(
  name: string,
  options: WorkflowStepConfig,
  run: () => Promise<A>
) => Promise<A>;

const HTTP_OK = 200;

const HTTP_ACCEPTED = 202;

const coordinatedStatementStep = (
  coordinator: StatementCoordinator,
  work: typeof Work.Type,
  kind: "StatementWork" | "StatementFailed"
): Promise<boolean> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const safeWork = yield* sanitizeWorkTrace(work);
      const traceHeaders = yield* workTraceHeaders(safeWork);

      const body = yield* Schema.encodeEffect(Schema.fromJsonString(CoordinatorWork))(
        coordinatorActivity[kind](safeWork)
      ).pipe(Effect.mapError((cause) => new StatementDeliveryUnavailable({ cause })));

      const result = yield* Effect.tryPromise({
        try: () =>
          coordinator.getByName(work.userId).fetch(
            new Request("https://coordinator.internal/statement-work", {
              method: "POST",
              headers: { "content-type": "application/json", ...traceHeaders },
              body,
            })
          ),
        catch: (cause) => new StatementDeliveryUnavailable({ cause }),
      });

      if (
        result.status !== HTTP_OK &&
        !(kind === "StatementWork" && result.status === HTTP_ACCEPTED)
      ) {
        return yield* new StatementDeliveryUnavailable({ cause: "coordinator_unavailable" });
      }

      return result.status === HTTP_ACCEPTED;
    })
  );

export const runStatementExtractionWorkflow = (
  input: Readonly<{
    payload: unknown;
    coordinator: StatementCoordinator;
    activity: Activity;
  }>
): Promise<void> => {
  const work = Schema.decodeUnknownOption(Work)(input.payload);

  if (Option.isNone(work)) return Promise.resolve();

  return Effect.runPromise(
    Effect.gen(function* () {
      const nextIndex = yield* Ref.make(0);

      const finalizeChunk = Effect.gen(function* () {
        const index = yield* Ref.getAndUpdate(nextIndex, (current) => current + 1);

        const outcome = yield* Effect.exit(
          Effect.tryPromise({
            try: () =>
              input.activity(
                `finalize-statement-chunk-v1-${index}`,
                { retries: { limit: 2, delay: "1 minute", backoff: "exponential" } },
                () => coordinatedStatementStep(input.coordinator, work.value, "StatementWork")
              ),
            catch: (cause) => new StatementDeliveryUnavailable({ cause }),
          })
        );

        if (Exit.isFailure(outcome)) {
          if (Cause.hasInterrupts(outcome.cause)) return yield* Effect.failCause(outcome.cause);

          return Option.some(false);
        }

        return outcome.value ? Option.none<boolean>() : Option.some(true);
      });

      const finished = yield* finalizeChunk.pipe(
        Effect.repeat({ while: Option.isNone, times: maximumStatementChunkActivities - 1 })
      );

      if (Option.getOrElse(finished, () => false)) return;
      yield* Effect.tryPromise({
        try: () =>
          input.activity(
            "report-statement-interruption-v1",
            { retries: { limit: 2, delay: "1 minute", backoff: "exponential" } },
            () => coordinatedStatementStep(input.coordinator, work.value, "StatementFailed")
          ),
        catch: (cause) => new StatementDeliveryUnavailable({ cause }),
      });
    })
  );
};
