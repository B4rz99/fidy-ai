import {
  captureWorkTrace,
  sanitizeWorkTrace,
  workTraceHeaders,
} from "../../runtime/telemetry/operations";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { Cause, Clock, Effect, Exit, Option, Result, Schema } from "effect";
import {
  StatementCoordinatorActivity,
  StatementDeliveryUnavailable,
  type StatementQueue,
  StatementWork,
  type StatementWorkflow,
  statementWorkflowRetention as retention,
} from "../contract";
import { maximumStatementChunkActivities } from "./statement-processing-limits";

const Work = StatementWork;
const CoordinatorWork = StatementCoordinatorActivity;
const OutboxRow = Schema.Struct({
  user_id: Schema.String.check(Schema.isUUID()),
  submission_id: StatementWork.fields.submissionId,
  revision: Schema.Literal(1),
});
const SubmissionState = Schema.Struct({
  status: Schema.Literals(["queued", "processing", "completed", "failed"]),
});
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
const dispatchLimit = 32;
const dispatchCooldownMs = 60_000;

const attempt = <A>(run: () => PromiseLike<A>): Effect.Effect<A, StatementDeliveryUnavailable> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new StatementDeliveryUnavailable({ cause }),
  });

export const isStatementExtractionWork = (body: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(Work)(body));

/** Reoffers a bounded page of unsettled D1 intents. Failed handoffs leave their identity selectable. */
export const dispatchStatementExtraction = (
  environment: Readonly<{
    DB: D1Database;
    userId: Option.Option<string>;
    STATEMENT_EXTRACTION_QUEUE: StatementQueue;
    STATEMENT_EXTRACTION_WORKFLOW: Option.Option<StatementWorkflow>;
  }>
): Effect.Effect<void, StatementDeliveryUnavailable> =>
  Effect.gen(function* () {
    const trace = yield* captureWorkTrace;
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* attempt(() =>
      environment.DB.prepare(`SELECT user_id, id AS submission_id, 1 AS revision
        FROM statement_submissions
        WHERE work_published_at_ms IS NOT NULL AND status IN ('queued', 'processing')
          AND (work_last_attempt_at_ms IS NULL OR work_last_attempt_at_ms < ?)
          ${Option.isSome(environment.userId) ? "AND user_id = ?" : ""}
        ORDER BY work_published_at_ms, id LIMIT ?`)
        .bind(now - dispatchCooldownMs, ...Option.toArray(environment.userId), dispatchLimit)
        .all()
    );
    const entries = yield* Schema.decodeUnknownEffect(Schema.Array(OutboxRow))(rows.results).pipe(
      Effect.mapError((cause) => new StatementDeliveryUnavailable({ cause }))
    );
    let failed = false;
    for (const entry of entries) {
      const claimed = yield* attempt(() =>
        environment.DB.prepare(`UPDATE statement_submissions SET work_last_attempt_at_ms = ?
          WHERE work_published_at_ms IS NOT NULL AND id = ? AND user_id = ?
          AND (work_last_attempt_at_ms IS NULL OR work_last_attempt_at_ms < ?)`)
          .bind(now, entry.submission_id, entry.user_id, now - dispatchCooldownMs)
          .run()
      );
      if (claimed.meta.changes !== 1) continue;
      const offered = yield* Effect.exit(
        offerStatementExtraction(environment, {
          ...trace,
          version: entry.revision,
          userId: entry.user_id,
          submissionId: entry.submission_id,
        })
      );
      if (Exit.isFailure(offered)) {
        if (Cause.hasInterrupts(offered.cause)) return yield* Effect.failCause(offered.cause);
        failed = true;
      }
    }
    if (failed) return yield* new StatementDeliveryUnavailable({ cause: "queue_unavailable" });
  }).pipe(Effect.withSpan("ingestion.statementDispatch"));

/** Decode before looking up authority; forged and stale work cannot start an extraction. */
export const receiveStatementExtraction = (
  input: Readonly<{
    environment: Readonly<{ DB: D1Database; STATEMENT_EXTRACTION_WORKFLOW: StatementWorkflow }>;
    messages: ReadonlyArray<Readonly<{ body: unknown; ack: () => void }>>;
  }>
): Effect.Effect<void, StatementDeliveryUnavailable> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const message of input.messages) {
      const work = Schema.decodeUnknownOption(Work)(message.body);
      if (Option.isNone(work)) {
        message.ack();
        continue;
      }
      const row = yield* attempt(() =>
        input.environment.DB.prepare(`SELECT status FROM statement_submissions
          WHERE id = ? AND user_id = ? AND retention_expires_at_ms > ?`)
          .bind(work.value.submissionId, work.value.userId, now)
          .first()
      );
      if (row === null) {
        message.ack();
        continue;
      }
      const submission = yield* Schema.decodeUnknownEffect(SubmissionState)(row).pipe(
        Effect.mapError((cause) => new StatementDeliveryUnavailable({ cause }))
      );
      if (submission.status === "completed" || submission.status === "failed") {
        message.ack();
        continue;
      }
      const params = yield* sanitizeWorkTrace(work.value);
      const started = yield* Effect.exit(
        attempt(() =>
          input.environment.STATEMENT_EXTRACTION_WORKFLOW.create({
            id: work.value.submissionId,
            params,
            retention,
          })
        )
      );
      if (Exit.isFailure(started)) {
        if (Cause.hasInterrupts(started.cause)) return yield* Effect.failCause(started.cause);
        yield* attempt(() =>
          input.environment.STATEMENT_EXTRACTION_WORKFLOW.get(work.value.submissionId)
        );
      }
      message.ack();
    }
  }).pipe(Effect.withSpan("ingestion.statementReceive"));

/** Direct handoff accelerates the committed outbox; an unavailable create/get falls back to the
 * same Queue identity. Both paths use the receiver's current eligibility and stable Workflow id.
 */
const offerStatementExtraction = (
  environment: Readonly<{
    DB: D1Database;
    STATEMENT_EXTRACTION_QUEUE: StatementQueue;
    STATEMENT_EXTRACTION_WORKFLOW: Option.Option<StatementWorkflow>;
  }>,
  body: typeof Work.Type
): Effect.Effect<void, StatementDeliveryUnavailable> =>
  Effect.gen(function* () {
    const workflow = environment.STATEMENT_EXTRACTION_WORKFLOW;
    if (Option.isSome(workflow)) {
      const delivered = yield* Effect.exit(
        receiveStatementExtraction({
          environment: { DB: environment.DB, STATEMENT_EXTRACTION_WORKFLOW: workflow.value },
          messages: [{ body, ack: (): void => undefined }],
        })
      );
      if (Exit.isSuccess(delivered)) return;
      if (Cause.hasInterrupts(delivered.cause)) return yield* Effect.failCause(delivered.cause);
    }
    yield* attempt(() => environment.STATEMENT_EXTRACTION_QUEUE.send(body));
  });

/** One private coordinator target; the Workflow never stores bytes, row facts, or credentials. */
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

/** Reconcile failed or completed Workflow instances whose final report activity also exhausted.
 * The authoritative submission remains nonterminal until its own User coordinator settles it.
 * A bounded rotating scan prevents an active Workflow from hiding a later errored one.
 */
export const reconcileStatementExtraction = (
  input: Readonly<{
    DB: D1Database;
    STATEMENT_EXTRACTION_WORKFLOW: Pick<StatementWorkflow, "get">;
    USER_TRANSACTION_COORDINATOR: StatementCoordinator;
  }>
): Effect.Effect<void, StatementDeliveryUnavailable> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const selected = yield* attempt(() =>
      input.DB.prepare(`SELECT user_id, id AS submission_id, 1 AS revision
      FROM statement_submissions
      WHERE work_published_at_ms IS NOT NULL AND work_published_at_ms > 0
        AND status IN ('queued', 'processing') AND retention_expires_at_ms > ?
      ORDER BY work_last_reconciled_at_ms, work_published_at_ms, id LIMIT ?`)
        .bind(now, dispatchLimit)
        .all()
    );
    const work = yield* Schema.decodeUnknownEffect(Schema.Array(OutboxRow))(selected.results).pipe(
      Effect.mapError((cause) => new StatementDeliveryUnavailable({ cause }))
    );
    for (const row of work) {
      yield* attempt(() =>
        input.DB.prepare(
          `UPDATE statement_submissions SET work_last_reconciled_at_ms = ? WHERE work_published_at_ms IS NOT NULL AND id = ? AND user_id = ?`
        )
          .bind(now, row.submission_id, row.user_id)
          .run()
      );
      const state = yield* Effect.result(
        workflowState(input.STATEMENT_EXTRACTION_WORKFLOW, row.submission_id)
      );
      if (Result.isFailure(state)) continue;
      if (!["errored", "terminated", "complete"].includes(state.success.status)) continue;
      yield* attempt(() =>
        coordinatedStatementStep(
          input.USER_TRANSACTION_COORDINATOR,
          { version: row.revision, userId: row.user_id, submissionId: row.submission_id },
          "StatementFailed"
        )
      );
    }
  }).pipe(Effect.withSpan("ingestion.statementReconcile"));

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
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(CoordinatorWork))({
        _tag: kind,
        ...safeWork,
      }).pipe(Effect.mapError((cause) => new StatementDeliveryUnavailable({ cause })));
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

/** Runs an identity-only activity under the User's coordination boundary. */
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
      let finished = false;
      for (let index = 0; index < maximumStatementChunkActivities; index += 1) {
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
          break;
        }
        if (!outcome.value) {
          finished = true;
          break;
        }
      }
      if (finished) return;
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
