import { Config, DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { Activity, DurableClock } from "effect/unstable/workflow";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import {
  BrowserPairingEmailWorkflowId,
  EmailAddress,
  EmailVerificationCode,
  EmailVerificationPublicCode,
} from "~/core/email-authentication/model";
import { proofExpiry } from "~/core/email-authentication/rules";
import { lockPendingBrowserLoginPairingInScope } from "~/shell/browser-login/service";
import { withSubjectLockInScope } from "~/shell/consent/repo";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { attemptEmailDelivery, settleTerminalEmailFailure } from "./delivery-retry";
import {
  digestBrowserPairingEmailProof,
  processBrowserPairingEmailStartRequest,
} from "./browser-pairing-authentication";
import { makeEmailDeliveryProof } from "./repo";
import {
  BrowserPairingEmailDeliveryWorkflow,
  BrowserPairingEmailExpiryWorkflow,
  type PairingDeliveryPayload,
  PairingDeliveryResult,
  type PairingExpiryPayload,
  pairingDeliveryQueue,
  pairingExpiryQueue,
  pairingStartQueue,
} from "./pairing-email-execution";

const AttemptResult = Schema.Union([
  PairingDeliveryResult,
  Schema.Struct({ outcome: Schema.Literal("retry"), retryAt: Schema.DateTimeUtc }),
]);
type AttemptResult = typeof AttemptResult.Type;
const DeliveryRow = Schema.Struct({
  workflowId: BrowserPairingEmailWorkflowId,
  pairingId: BrowserLoginPairingId,
  generation: Schema.Int,
  emailAddress: EmailAddress,
  publicCode: EmailVerificationPublicCode,
  expiresAt: Schema.DateTimeUtcFromDate,
  status: Schema.Literals([
    "pending",
    "armed",
    "sent",
    "rejected",
    "uncertain",
    "superseded",
    "temporarily-refused",
    "retry-exhausted",
  ]),
  providerAttempt: Schema.Int,
  retryAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  current: Schema.Boolean,
});
type DeliveryRow = typeof DeliveryRow.Type;
type Prepared = Readonly<{ row: DeliveryRow; combinedCode: EmailVerificationCode }>;

const initialRetryDelayMilliseconds = 250;
const maximumProviderAttempts = 3;

const terminalResult: Readonly<
  Record<DeliveryRow["status"], Option.Option<PairingDeliveryResult>>
> = {
  pending: Option.none(),
  armed: Option.some({ outcome: "uncertain" }),
  sent: Option.some({ outcome: "sent" }),
  rejected: Option.some({ outcome: "refused" }),
  uncertain: Option.some({ outcome: "uncertain" }),
  superseded: Option.some({ outcome: "not-current" }),
  "temporarily-refused": Option.none(),
  "retry-exhausted": Option.some({ outcome: "retry-exhausted" }),
};

const replayProviderEvidence = Effect.fn(function* (
  payload: PairingDeliveryPayload,
  row: DeliveryRow,
  attempt: number
) {
  if (row.status === "armed") {
    // The raw body is intentionally unrecoverable. Armed replay cannot repeat a remote effect.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE browser_pairing_email_delivery_intents SET status = 'uncertain'
      WHERE id = ${payload.intentId}`.pipe(Effect.orDie);
  }
  if (row.status === "temporarily-refused" && row.providerAttempt === attempt) {
    return Option.some<AttemptResult>({
      outcome: "retry",
      retryAt: Option.getOrThrow(row.retryAt),
    });
  }
  return terminalResult[row.status];
});

const inDeliveryScope = <A, E, R>(
  payload: PairingDeliveryPayload,
  work: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | SqlClient.SqlClient> =>
  withUserTransaction(
    payload.userId,
    withSubjectLockInScope(
      payload.userId,
      withUserLockInScope(advisoryLockKey.browserLoginApproval(payload.userId), work)
    )
  );

const prepare = Effect.fn(function* (payload: PairingDeliveryPayload, attempt: number) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const found = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: DeliveryRow,
    execute: () => sql`
      SELECT workflow.id AS "workflowId", workflow.pairing_id AS "pairingId", intent.generation,
        intent.email_address AS "emailAddress", workflow.public_code AS "publicCode",
        workflow.expires_at AS "expiresAt", intent.status, intent.provider_attempt AS "providerAttempt",
        intent.retry_at AS "retryAt",
        (intent.generation = workflow.delivery_generation AND EXISTS (
          SELECT 1 FROM verified_email_credentials credential WHERE credential.user_id = ${payload.userId}
            AND credential.email_address = intent.email_address
            AND credential.verified_at = workflow.credential_verified_at
        )) AS current
      FROM browser_pairing_email_delivery_intents intent
      JOIN browser_pairing_email_workflows workflow ON workflow.id = intent.workflow_id
      WHERE intent.id = ${payload.intentId} AND workflow.user_id = ${payload.userId}
      FOR UPDATE OF intent, workflow
    `,
  })(undefined).pipe(Effect.orDie);
  if (Option.isNone(found)) return { outcome: "not-current" } satisfies AttemptResult;
  const row = found.value;
  if (!row.current || row.status === "superseded") {
    return { outcome: "not-current" } satisfies AttemptResult;
  }
  if (DateTime.toEpochMillis(row.expiresAt) <= DateTime.toEpochMillis(now)) {
    return { outcome: "expired" } satisfies AttemptResult;
  }
  const replayed = yield* replayProviderEvidence(payload, row, attempt);
  if (Option.isSome(replayed)) return replayed.value;
  if (row.providerAttempt !== attempt - 1) {
    return { outcome: "not-current" } satisfies AttemptResult;
  }
  const live = yield* lockPendingBrowserLoginPairingInScope(row.pairingId, now);
  if (Option.isNone(live)) return { outcome: "not-current" } satisfies AttemptResult;
  const { proof } = yield* makeEmailDeliveryProof();
  const digest = yield* digestBrowserPairingEmailProof(row.pairingId, proof);
  yield* sql`UPDATE browser_pairing_email_delivery_intents
    SET status = 'armed', provider_attempt = ${attempt}, retry_at = NULL WHERE id = ${payload.intentId}`.pipe(
    Effect.orDie
  );
  yield* sql`UPDATE browser_pairing_email_workflows SET proof_digest = ${digest},
    proof_expires_at = LEAST(${proofExpiry(now)}, expires_at), wrong_proof_attempts = 0
    WHERE id = ${row.workflowId}`.pipe(Effect.orDie);
  return {
    row,
    combinedCode: EmailVerificationCode.make(`${row.publicCode}-${proof}`),
  } satisfies Prepared;
});

const deliveryStatus = (result: AttemptResult): string => {
  if (result.outcome === "retry") return "temporarily-refused";
  if (result.outcome === "refused") return "rejected";
  return result.outcome;
};

const settle = Effect.fn(function* ({
  payload,
  prepared,
  attempt,
  result,
}: {
  payload: PairingDeliveryPayload;
  prepared: Prepared;
  attempt: number;
  result: AttemptResult;
}) {
  const sql = yield* SqlClient.SqlClient;
  const status = deliveryStatus(result);
  const updated = yield* sql`
    UPDATE browser_pairing_email_delivery_intents intent
    SET status = ${status}, retry_at = ${result.outcome === "retry" ? sql`${result.retryAt}` : sql`NULL`}
    FROM browser_pairing_email_workflows workflow
    WHERE intent.id = ${payload.intentId} AND workflow.id = intent.workflow_id
      AND workflow.id = ${prepared.row.workflowId} AND workflow.user_id = ${payload.userId}
      AND intent.status = 'armed' AND intent.provider_attempt = ${attempt}
      AND intent.generation = ${prepared.row.generation}
      AND workflow.delivery_generation = ${prepared.row.generation}
    RETURNING intent.id
  `.pipe(Effect.orDie);
  if (updated.length === 0) return { outcome: "not-current" } satisfies AttemptResult;
  if (
    result.outcome === "retry" ||
    result.outcome === "refused" ||
    result.outcome === "retry-exhausted"
  ) {
    yield* sql`UPDATE browser_pairing_email_workflows SET proof_digest = NULL, proof_expires_at = NULL
      WHERE id = ${prepared.row.workflowId}`.pipe(Effect.orDie);
  }
  return result;
});

const deliverAttempt = Effect.fn(function* (payload: PairingDeliveryPayload, attempt: number) {
  const prepared = yield* inDeliveryScope(payload, prepare(payload, attempt));
  if ("outcome" in prepared) return prepared;
  const sent = yield* attemptEmailDelivery({
    purpose: "browser-pairing-approval",
    to: prepared.row.emailAddress,
    combinedCode: prepared.combinedCode,
    idempotencyKey: `${payload.intentId}/${attempt}`,
  }).pipe(Effect.result);
  let result: AttemptResult;
  if (Result.isSuccess(sent)) result = { outcome: "sent" };
  else if (
    sent.failure.certainty === "rejected" &&
    sent.failure.retryable &&
    attempt < maximumProviderAttempts
  ) {
    result = {
      outcome: "retry",
      retryAt: DateTime.add(yield* DateTime.now, {
        milliseconds: initialRetryDelayMilliseconds * 2 ** (attempt - 1),
      }),
    };
  } else {
    const status = yield* settleTerminalEmailFailure(sent.failure);
    const refusedOutcome = sent.failure.retryable ? "retry-exhausted" : "refused";
    result = { outcome: status === "uncertain" ? "uncertain" : refusedOutcome };
  }
  return yield* inDeliveryScope(payload, settle({ payload, prepared, attempt, result }));
});

const runDelivery = Effect.fn("EmailAuthentication.deliverPairingEmail")(function* (
  payload: PairingDeliveryPayload
) {
  for (let attempt = 1; attempt <= maximumProviderAttempts; attempt++) {
    const result = yield* Activity.make({
      name: "DeliverPairingEmail",
      success: AttemptResult,
      execute: deliverAttempt(payload, attempt),
    }).pipe(Effect.provideService(Activity.CurrentAttempt, attempt));
    if (result.outcome !== "retry") return result;
    const remaining =
      DateTime.toEpochMillis(result.retryAt) - DateTime.toEpochMillis(yield* DateTime.now);
    if (remaining > 0) {
      yield* DurableClock.sleep({
        name: `PairingEmailRetry/${attempt}`,
        duration: remaining,
        inMemoryThreshold: "0 millis",
      });
    }
  }
  return { outcome: "retry-exhausted" } satisfies PairingDeliveryResult;
});

const expirePairingEmail = Effect.fn(function* (payload: PairingExpiryPayload) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  yield* withUserTransaction(
    payload.userId,
    withSubjectLockInScope(
      payload.userId,
      withUserLockInScope(
        advisoryLockKey.browserLoginApproval(payload.userId),
        sql`DELETE FROM browser_pairing_email_workflows
        WHERE id = ${payload.workflowId} AND user_id = ${payload.userId} AND expires_at <= ${now}`.pipe(
          Effect.orDie
        )
      )
    )
  );
});

/** Native durable definitions; activities never serialize their in-memory email projection. */
export const BrowserPairingEmailWorkflowLive = Layer.mergeAll(
  BrowserPairingEmailDeliveryWorkflow.toLayer(runDelivery),
  BrowserPairingEmailExpiryWorkflow.toLayer(
    Effect.fn(function* (payload) {
      const deadline = yield* Activity.make({
        name: "PairingEmailDeadline",
        success: Schema.Option(Schema.DateTimeUtc),
        execute: withUserTransaction(
          payload.userId,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* SqlSchema.findOneOption({
              Request: Schema.Void,
              Result: Schema.Struct({ expiresAt: Schema.DateTimeUtcFromDate }),
              execute:
                () => sql`SELECT expires_at AS "expiresAt" FROM browser_pairing_email_workflows
            WHERE id = ${payload.workflowId} AND user_id = ${payload.userId}`,
            })(undefined).pipe(Effect.orDie, Effect.map(Option.map((row) => row.expiresAt)));
          })
        ),
      });
      if (Option.isNone(deadline)) return;
      const remaining =
        DateTime.toEpochMillis(deadline.value) - DateTime.toEpochMillis(yield* DateTime.now);
      if (remaining > 0) {
        yield* DurableClock.sleep({
          name: "PairingEmailExpiry",
          duration: remaining,
          inMemoryThreshold: "0 millis",
        });
      }
      yield* Activity.make({ name: "ExpirePairingEmail", execute: expirePairingEmail(payload) });
    })
  )
);

/** Native consumers own acquisition and wakeups; fixed concurrency bounds provider work per process. */
export const BrowserPairingEmailDeliveryWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    if (
      (yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"))) !== "production"
    ) {
      return;
    }
    const starts = yield* pairingStartQueue;
    const deliveries = yield* pairingDeliveryQueue;
    const expiries = yield* pairingExpiryQueue;
    yield* starts
      .take(({ requestId }) => processBrowserPairingEmailStartRequest(requestId))
      .pipe(Effect.forever, Effect.forkScoped);
    yield* deliveries
      .take((payload) => BrowserPairingEmailDeliveryWorkflow.execute(payload))
      .pipe(Effect.forever, Effect.forkScoped);
    // Expiry is submitted without occupying a worker until the ten-minute deadline.
    yield* expiries
      .take((payload) => BrowserPairingEmailExpiryWorkflow.execute(payload, { discard: true }))
      .pipe(Effect.forever, Effect.forkScoped);
  })
);

/** Closed progress signal for the finite channel-worker acceptance seam. */
export type BrowserPairingEmailBackgroundStepOutcome = Readonly<{ _tag: "Idle" | "Progressed" }>;

/** Drives native queues and the real workflow handler without a production polling fiber. */
export const processNextBackgroundStep = Effect.fn("EmailAuthentication.processNextBackgroundStep")(
  function* () {
    const starts = yield* pairingStartQueue;
    const deliveries = yield* pairingDeliveryQueue;
    const started = yield* starts
      .take(({ requestId }) => processBrowserPairingEmailStartRequest(requestId))
      .pipe(Effect.as(true), Effect.timeoutOption("1100 millis"));
    const delivered = yield* deliveries
      .take((payload) => BrowserPairingEmailDeliveryWorkflow.execute(payload))
      .pipe(Effect.as(true), Effect.timeoutOption("2 seconds"));
    return {
      _tag: Option.isSome(started) || Option.isSome(delivered) ? "Progressed" : "Idle",
    } satisfies BrowserPairingEmailBackgroundStepOutcome;
  }
);
