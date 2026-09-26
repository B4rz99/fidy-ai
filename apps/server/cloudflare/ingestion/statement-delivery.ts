import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { Clock, Data, Effect, Exit, Option, Result, Schema } from "effect";
import { StatementCoordinatorActivity, StatementWork } from "./statement-work";
import { maximumStatementChunkActivities } from "./statement-processing-limits";

/** Version 1 has no earlier history to migrate; old instances drain before changing activity names. */
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
const retention = { successRetention: "3 days", errorRetention: "3 days" } as const;
const dispatchLimit = 32;
const dispatchCooldownMs = 60_000;

/** Publish only versioned User/submission identity. A resolved send means the Queue accepted an
 * offer, not that extraction completed; a rejected send may still have been accepted, so the
 * outbox retries the same idempotent identity after its cooldown. No bytes or passwords enter it.
 */
export type StatementQueue = Readonly<{
  send: (work: typeof Work.Type) => Promise<unknown>;
}>;
/** Create one Workflow instance keyed by submission id. A resolved create means the instance
 * exists, not that it finished. If creation rejects ambiguously, get must resolve an existing
 * instance before Queue acknowledgement; a missing/unavailable get must reject for redelivery.
 * get may return an errored instance: the scheduled reconciler inspects status and settles it
 * under the User coordinator. The three-day retention applies to Workflow state only.
 */
export type StatementWorkflow = Readonly<{
  create: (options: {
    id: string;
    params: typeof Work.Type;
    retention: typeof retention;
  }) => Promise<unknown>;
  get: (id: string) => Promise<unknown>;
}>;

class StatementDeliveryUnavailable extends Data.TaggedError("StatementDeliveryUnavailable")<{
  readonly cause: unknown;
}> {}
const attempt = <A>(run: () => PromiseLike<A>): Effect.Effect<A, StatementDeliveryUnavailable> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new StatementDeliveryUnavailable({ cause }),
  });

/** True only for a structurally valid, versioned statement Queue envelope. */
export const isStatementExtractionWork = (body: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(Work)(body));

/** Reoffers a bounded page of unsettled D1 intents. A failed send leaves its identity selectable. */
export const dispatchStatementExtraction = (
  environment: Readonly<{
    DB: D1Database;
    STATEMENT_EXTRACTION_QUEUE: StatementQueue;
  }>
): Effect.Effect<void, StatementDeliveryUnavailable> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* attempt(() =>
      environment.DB.prepare(`SELECT o.user_id, o.submission_id, o.revision
        FROM statement_ingestion_outbox AS o
        JOIN statement_submissions AS s ON s.id = o.submission_id AND s.user_id = o.user_id
        WHERE s.status IN ('queued', 'processing')
          AND (o.last_attempt_at_ms IS NULL OR o.last_attempt_at_ms < ?)
        ORDER BY o.last_attempt_at_ms, o.published_at_ms, o.submission_id LIMIT ?`)
        .bind(now - dispatchCooldownMs, dispatchLimit)
        .all()
    );
    const entries = yield* Schema.decodeUnknownEffect(Schema.Array(OutboxRow))(rows.results).pipe(
      Effect.mapError((cause) => new StatementDeliveryUnavailable({ cause }))
    );
    let failed = false;
    for (const entry of entries) {
      const claimed = yield* attempt(() =>
        environment.DB.prepare(`UPDATE statement_ingestion_outbox SET last_attempt_at_ms = ?
          WHERE submission_id = ? AND user_id = ?
          AND (last_attempt_at_ms IS NULL OR last_attempt_at_ms < ?)`)
          .bind(now, entry.submission_id, entry.user_id, now - dispatchCooldownMs)
          .run()
      );
      if (claimed.meta.changes !== 1) continue;
      const offered = yield* Effect.exit(
        attempt(() =>
          environment.STATEMENT_EXTRACTION_QUEUE.send({
            version: entry.revision,
            userId: entry.user_id,
            submissionId: entry.submission_id,
          })
        )
      );
      if (Exit.isFailure(offered)) failed = true;
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
      const started = yield* Effect.exit(
        attempt(() =>
          input.environment.STATEMENT_EXTRACTION_WORKFLOW.create({
            id: work.value.submissionId,
            params: work.value,
            retention,
          })
        )
      );
      if (Exit.isFailure(started)) {
        // A lost create response can still mean a running instance. Confirm before acknowledging.
        yield* attempt(() =>
          input.environment.STATEMENT_EXTRACTION_WORKFLOW.get(work.value.submissionId)
        );
      }
      message.ack();
    }
  }).pipe(Effect.withSpan("ingestion.statementReceive"));

/** One private coordinator target; the Workflow never stores bytes, row facts, or credentials. */
type StatementCoordinator = Readonly<{
  getByName: (name: string) => Pick<Fetcher, "fetch">;
}>;

// @effect-diagnostics-next-line asyncFunction:off
const workflowState = async (
  workflow: Pick<StatementWorkflow, "get">,
  id: string
): Promise<typeof WorkflowState.Type> => {
  const instance = await workflow.get(id);
  const statusMethod =
    typeof instance === "object" && instance !== null && "status" in instance
      ? instance.status
      : undefined;
  if (typeof statusMethod !== "function") throw new Error("Workflow status unavailable");
  return Schema.decodeUnknownSync(WorkflowState)(await statusMethod.call(instance));
};

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
      input.DB.prepare(`SELECT o.user_id, o.submission_id, o.revision
      FROM statement_ingestion_outbox o JOIN statement_submissions s
        ON s.id = o.submission_id AND s.user_id = o.user_id
      WHERE o.published_at_ms > 0 AND s.status IN ('queued', 'processing')
        AND s.retention_expires_at_ms > ?
      ORDER BY coalesce(o.last_attempt_at_ms, 0), o.submission_id LIMIT ?`)
        .bind(now, dispatchLimit)
        .all()
    );
    const work = yield* Schema.decodeUnknownEffect(Schema.Array(OutboxRow))(selected.results).pipe(
      Effect.mapError((cause) => new StatementDeliveryUnavailable({ cause }))
    );
    for (const row of work) {
      // Rotate even on transient get failure: the next scheduled run can inspect it again.
      yield* attempt(() =>
        input.DB.prepare(`UPDATE statement_ingestion_outbox
        SET last_attempt_at_ms = ? WHERE submission_id = ? AND user_id = ?`)
          .bind(now, row.submission_id, row.user_id)
          .run()
      );
      const state = yield* Effect.result(
        attempt(() => workflowState(input.STATEMENT_EXTRACTION_WORKFLOW, row.submission_id))
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
// Parser and Workflow share a row ceiling; 20,000 rows take at most 625 activities.
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;

const coordinatedStatementStep = (
  coordinator: StatementCoordinator,
  work: typeof Work.Type,
  kind: "StatementWork" | "StatementFailed"
): Promise<boolean> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(CoordinatorWork))({
        _tag: kind,
        ...work,
      }).pipe(Effect.mapError((cause) => new StatementDeliveryUnavailable({ cause })));
      const result = yield* Effect.tryPromise({
        try: () =>
          coordinator.getByName(work.userId).fetch(
            new Request("https://coordinator.internal/statement-work", {
              method: "POST",
              headers: { "content-type": "application/json" },
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
        if (Exit.isFailure(outcome)) break;
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

/** Cloudflare stores only the bounded work identity and the named activity outcome. */
export class StatementExtractionWorkflowV1 extends WorkflowEntrypoint<
  Readonly<{ USER_TRANSACTION_COORDINATOR: StatementCoordinator }>,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return runStatementExtractionWorkflow({
      payload: event.payload,
      coordinator: this.env.USER_TRANSACTION_COORDINATOR,
      activity: (name, options, run) => step.do(name, options, run),
    });
  }
}
