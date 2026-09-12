import {
  type Cause,
  Crypto,
  Data,
  DateTime,
  Effect,
  Array as EffectArray,
  Option,
  Schema,
} from "effect";
import {
  SqlClient,
  type SqlConnection,
  type SqlError,
  SqlSchema,
  type Statement,
} from "effect/unstable/sql";
import { UserId, type WhatsAppCallerReference } from "~/core/identity/reference";
import { TranscriptTurnId } from "~/core/transcript/model";
import { InboundMessage } from "~/shell/agent/message";
import { OnboardingConsentRequired } from "~/shell/agent/consent-error";
import type { AuthorizedAgentTurn } from "~/shell/agent/message";
import {
  ConfirmationDigest,
  confirmationDigestFromCommand,
} from "~/shell/agent/tool-confirmation-model";
import { hasCurrentOnboardingConsentAt, useCurrentConsent } from "~/shell/consent/repo";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { withUserTransaction } from "~/shell/db/user-transaction";
import {
  DurableTraceContext,
  TelemetryAttempt,
  TelemetryDuration,
} from "~/shell/observability/protocol";
import { findAndLockWhatsAppIdentity } from "~/shell/identity/repo";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppCaller,
  WhatsAppDeliveryKey,
  type WhatsAppInboundEvent,
  WhatsAppInboundJobId,
  type WhatsAppMessageEvidence,
  WhatsAppProviderMessageId,
} from "./model";
import {
  WhatsAppInboundWork,
  maximumWhatsAppInboundAttempts,
  whatsappInboundQueue,
} from "./inbound-execution";

const maximumBudgetKeyLength = 256;
const maximumQueueDelayMilliseconds = 86_400_000;

const WhatsAppReceiptClaimId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("WhatsAppReceiptClaimId")
);
type WhatsAppReceiptClaimId = typeof WhatsAppReceiptClaimId.Type;
type WhatsAppReceiptClaim = Readonly<{
  readonly providerMessageId: WhatsAppProviderMessageId;
  readonly claimId: WhatsAppReceiptClaimId;
}>;

/** Constructive result of inspecting the current User's free-form messaging window. */
export type WhatsAppWindowState =
  | Readonly<{ readonly _tag: "Open"; readonly windowOpenUntil: DateTime.Utc }>
  | Readonly<{
      readonly _tag: "Closed";
      readonly lastWindowOpenUntil: Option.Option<DateTime.Utc>;
    }>;

/** The stable User currently has no WhatsAppIdentity recipient. */
export class WhatsAppIdentityMissing extends Data.TaggedError("WhatsAppIdentityMissing")<{
  readonly userId: UserId;
}> {}
/** No free-form send is authorized for the User's current WhatsAppIdentity. */
export class WhatsAppWindowClosed extends Data.TaggedError("WhatsAppWindowClosed")<{
  readonly userId: UserId;
  readonly lastWindowOpenUntil: Option.Option<DateTime.Utc>;
}> {
  override get message(): string {
    return Option.match(this.lastWindowOpenUntil, {
      onNone: () => "No free-form WhatsApp send window is available",
      onSome: (closedAt) =>
        `The free-form WhatsApp send window closed at ${DateTime.formatIso(closedAt)}`,
    });
  }
}
/** Provider evidence collided with an already retained message identity. */
export class WhatsAppEvidenceConflict extends Data.TaggedError("WhatsAppEvidenceConflict")<{}> {}
/** The authenticated receipt claim was superseded before it could be completed. */
export class WhatsAppReceiptInvalid extends Data.TaggedError("WhatsAppReceiptInvalid")<{}> {}
/** Another delivery is still processing this authenticated provider message. */
export class WhatsAppReceiptInProgress extends Data.TaggedError("WhatsAppReceiptInProgress")<{}> {}
/** The authentic message cannot be admitted until bounded pending work drains. */
export class WhatsAppInboundCapacityExceeded extends Data.TaggedError(
  "WhatsAppInboundCapacityExceeded"
)<{}> {}
/** A durable hourly global, portfolio-scoped caller, or User ingress budget is exhausted. */
export class WhatsAppRateLimitExceeded extends Data.TaggedError("WhatsAppRateLimitExceeded")<{}> {}

const IngressBudgetScope = Schema.Union([
  Schema.TaggedStruct("Global", {}),
  Schema.TaggedStruct("Caller", { caller: WhatsAppCaller }),
  Schema.TaggedStruct("User", { userId: UserId }),
]);
/** Subject used to enforce either pre-association portfolio-scoped caller or stable-User limits. */
export type IngressBudgetScope = typeof IngressBudgetScope.Type;
const BudgetRequest = Schema.Struct({
  budgetKey: Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.isMaxLength(maximumBudgetKeyLength)
  ),
  providerMessageId: WhatsAppProviderMessageId,
  consumedAt: Schema.DateTimeUtcFromDate,
  maximumCount: Schema.Int.check(Schema.isGreaterThan(0)),
});
const BudgetResult = Schema.Struct({ consumed: Schema.Boolean });
const maximumHourlyIngressCount = 60;
const maximumGlobalHourlyIngressCount = 600;

/**
 * Atomically consumes one cross-instance hourly ingress permit without exposing budget state.
 * Replays of the same authenticated provider message in the same scope consume no additional
 * permit. Fails with WhatsAppRateLimitExceeded when the selected scope has no remaining permits.
 */
export const consumeWhatsAppIngressBudget = Effect.fn("WhatsApp.consumeIngressBudget")(function* (
  scope: IngressBudgetScope,
  providerMessageId: WhatsAppProviderMessageId,
  consumedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  let budgetKey: string;
  if (scope._tag === "Global") budgetKey = "global:authenticated";
  else if (scope._tag === "Caller") {
    budgetKey = `caller:${scope.caller.businessPortfolioId}:${scope.caller.businessScopedUserId}`;
  } else budgetKey = `user:${scope.userId}`;
  const request: typeof BudgetRequest.Type = {
    budgetKey,
    providerMessageId,
    consumedAt,
    maximumCount:
      scope._tag === "Global" ? maximumGlobalHourlyIngressCount : maximumHourlyIngressCount,
  };
  const consumed = yield* SqlSchema.findOne({
    Request: BudgetRequest,
    Result: BudgetResult,
    execute: (request) => sql`
        SELECT COALESCE(fidy_consume_whatsapp_budget_once(
          ${request.budgetKey}, ${request.providerMessageId},
          ${request.consumedAt}, ${request.maximumCount}
        ), false) AS consumed
      `,
  })(request).pipe(Effect.orDie);
  if (!consumed.consumed) return yield* new WhatsAppRateLimitExceeded();
});

/** Removes expired ingress counters and free-form windows without reading retained content. */
export const pruneWhatsAppOperationalData = Effect.fn("WhatsApp.pruneOperationalData")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT fidy_prune_whatsapp_operational_data()`.pipe(Effect.asVoid, Effect.orDie);
  }
);

const ExhaustedWhatsAppQueueItem = Schema.Struct({
  sequence: Schema.Int,
  element: Schema.String,
});
const WhatsAppInboundIdentity = Schema.fromJsonString(
  Schema.Struct({ userId: UserId, inboundJobId: WhatsAppInboundJobId })
);

/**
 * Terminally retires the inbound burst behind one durable item with metadata-only failure
 * evidence. The update settles only jobs that have not already completed, so a racing Turn
 * settlement wins and no retained content survives.
 */
export const failWhatsAppInboundBurst = Effect.fn("WhatsApp.failInboundBurst")(function* (
  work: Readonly<{ readonly userId: UserId; readonly inboundJobId: WhatsAppInboundJobId }>,
  terminalOutcome: "agent_failed" | "ambiguous_crash",
  failedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* withUserTransaction(
    work.userId,
    sql`UPDATE public.whatsapp_inbound_jobs AS job
      SET turn_id = coalesce(job.turn_id, job.id), content = NULL, completed_at = ${failedAt},
        terminal_outcome = ${terminalOutcome}
      WHERE job.user_id = ${work.userId} AND job.completed_at IS NULL
        AND (job.id = ${work.inboundJobId} OR job.turn_id = (
          SELECT trigger.turn_id FROM public.whatsapp_inbound_jobs AS trigger
          WHERE trigger.user_id = ${work.userId}
            AND trigger.id = ${work.inboundJobId}
        ))`.pipe(Effect.asVoid, Effect.catchTag("SqlError", Effect.die))
  );
});

/**
 * Terminally retires one bounded page of work whose native retry budget is exhausted and returns
 * the identities it retired, so the caller can retain one metadata-only failure record each.
 */
export const retireExhaustedWhatsAppWork = Effect.fn("WhatsApp.retireExhaustedWork")(function* (
  now: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const exhausted = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: ExhaustedWhatsAppQueueItem,
    execute: () => sql`SELECT sequence, element FROM fidy_queue
      WHERE queue_name = 'whatsapp-inbound-turn' AND completed = FALSE
        AND attempts >= ${maximumWhatsAppInboundAttempts}
      ORDER BY sequence LIMIT 256`,
  })(undefined).pipe(Effect.orDie);
  const retired: Array<
    Readonly<{ readonly userId: UserId; readonly inboundJobId: WhatsAppInboundJobId }>
  > = [];
  for (const item of exhausted) {
    const identity = Schema.decodeOption(WhatsAppInboundIdentity)(item.element);
    if (Option.isNone(identity)) {
      yield* sql`UPDATE fidy_queue SET last_failure = 'schema_incompatible', updated_at = ${now}
        WHERE sequence = ${item.sequence} AND completed = FALSE`.pipe(Effect.asVoid, Effect.orDie);
      yield* Effect.logWarning("Retained malformed exhausted WhatsApp work", {
        sequence: item.sequence,
      });
      continue;
    }
    yield* failWhatsAppInboundBurst(identity.value, "agent_failed", now);
    yield* sql`UPDATE fidy_queue SET completed = TRUE, acquired_at = NULL, acquired_by = NULL,
      updated_at = ${now} WHERE sequence = ${item.sequence} AND completed = FALSE
        AND attempts >= ${maximumWhatsAppInboundAttempts}`.pipe(Effect.asVoid, Effect.orDie);
    retired.push(identity.value);
  }
  if (retired.length > 0) {
    yield* Effect.logWarning("Retired exhausted WhatsApp work", { count: retired.length });
  }
  return retired;
});

const QueueHistoryCandidate = Schema.Struct({
  sequence: Schema.Int,
  element: Schema.String,
  id: Schema.String,
});
const UnfinishedJob = Schema.Struct({ id: WhatsAppInboundJobId });

/** Removes one bounded page of completed queue history after the replay horizon. */
export const pruneWhatsAppQueueHistory = Effect.fn("WhatsApp.pruneQueueHistory")(function* (
  now: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const cutoff = DateTime.subtract(now, { hours: 24 });
  const candidates = yield* SqlSchema.findAll({
    Request: Schema.DateTimeUtc,
    Result: QueueHistoryCandidate,
    execute: (before) => sql`SELECT sequence, element, id FROM fidy_queue
      WHERE queue_name = 'whatsapp-inbound-turn' AND completed = TRUE AND updated_at < ${before}
      ORDER BY sequence LIMIT 256`,
  })(cutoff).pipe(Effect.orDie);
  for (const candidate of candidates) {
    const identity = Schema.decodeOption(WhatsAppInboundIdentity)(candidate.element);
    if (Option.isNone(identity)) {
      yield* Effect.logWarning("Retained malformed WhatsApp queue history", {
        sequence: candidate.sequence,
      });
      continue;
    }
    const unfinished = yield* withUserTransaction(
      identity.value.userId,
      SqlSchema.findAll({
        Request: Schema.String,
        Result: UnfinishedJob,
        execute: (id) => sql`SELECT id FROM public.whatsapp_inbound_jobs
          WHERE user_id = ${identity.value.userId} AND id::text = ${id} AND completed_at IS NULL`,
      })(candidate.id).pipe(Effect.orDie)
    );
    if (unfinished.length === 0) {
      yield* sql`DELETE FROM fidy_queue WHERE sequence = ${candidate.sequence} AND completed = TRUE`.pipe(
        Effect.asVoid,
        Effect.orDie
      );
    }
  }
});

const ReceiptClaimRequest = Schema.Struct({
  providerMessageId: WhatsAppProviderMessageId,
  deliveryKey: WhatsAppDeliveryKey,
  claimId: WhatsAppReceiptClaimId,
  claimedAt: Schema.DateTimeUtcFromDate,
});
const ReceiptClaimKey = Schema.Struct({
  providerMessageId: WhatsAppProviderMessageId,
  claimId: WhatsAppReceiptClaimId,
});
const ReceiptCompleteRequest = Schema.Struct({
  ...ReceiptClaimKey.fields,
  completedAt: Schema.DateTimeUtcFromDate,
});
const ReceiptCompletionResult = Schema.Struct({ completed: Schema.Boolean });
const ReceiptOutboundStartedResult = Schema.Struct({ marked: Schema.Boolean });
const ReceiptClaimResult = Schema.Struct({
  state: Schema.Literals(["claimed", "completed", "in_progress"]),
});

/**
 * Claims one authenticated provider message for consent or queue admission. Completed replays
 * return no claim. An active delivery fails with WhatsAppReceiptInProgress so it is not acknowledged
 * before the owner finishes or releases the claim.
 */
export const claimWhatsAppReceipt = Effect.fn("WhatsApp.claimReceipt")(function* (
  providerMessageId: WhatsAppProviderMessageId,
  deliveryKey: WhatsAppDeliveryKey,
  claimedAt: DateTime.Utc
) {
  const crypto = yield* Crypto.Crypto;
  const claimId = WhatsAppReceiptClaimId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const sql = yield* SqlClient.SqlClient;
  const result = yield* SqlSchema.findOne({
    Request: ReceiptClaimRequest,
    Result: ReceiptClaimResult,
    execute: (request) => sql`
      SELECT fidy_claim_whatsapp_receipt(
        ${request.providerMessageId}, ${request.deliveryKey}, ${request.claimId}, ${request.claimedAt}
      ) AS state
    `,
  })({ providerMessageId, deliveryKey, claimId, claimedAt }).pipe(Effect.orDie);
  if (result.state === "in_progress") return yield* new WhatsAppReceiptInProgress();
  return result.state === "claimed"
    ? Option.some({ providerMessageId, claimId } satisfies WhatsAppReceiptClaim)
    : Option.none<WhatsAppReceiptClaim>();
});

/** Releases a failed receipt claim before provider delivery starts; stale claims are untouched. */
export const releaseWhatsAppReceipt = Effect.fn("WhatsApp.releaseReceipt")(function* (
  claim: WhatsAppReceiptClaim
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    SELECT fidy_release_whatsapp_receipt(${claim.providerMessageId}, ${claim.claimId})
  `.pipe(Effect.asVoid, Effect.orDie);
});

/**
 * Marks the provider boundary as started. Redelivery then treats an interrupted call as terminally
 * ambiguous instead of risking a duplicate outbound message.
 */
export const markWhatsAppReceiptOutboundStarted = Effect.fn("WhatsApp.markReceiptOutboundStarted")(
  function* (claim: WhatsAppReceiptClaim) {
    const sql = yield* SqlClient.SqlClient;
    const result = yield* SqlSchema.findOne({
      Request: ReceiptClaimKey,
      Result: ReceiptOutboundStartedResult,
      execute: (request) => sql`
      SELECT COALESCE(fidy_mark_whatsapp_receipt_outbound_started(
        ${request.providerMessageId}, ${request.claimId}
      ), false) AS marked
    `,
    })(claim).pipe(Effect.orDie);
    if (!result.marked) return yield* new WhatsAppReceiptInvalid();
  }
);

/**
 * Completes exactly the current receipt claim so stale workers cannot finalize reclaimed work.
 * Fails with WhatsAppReceiptInvalid when the claim is absent, stale, or already completed.
 */
export const completeWhatsAppReceipt = Effect.fn("WhatsApp.completeReceipt")(function* (
  claim: WhatsAppReceiptClaim,
  completedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const result = yield* SqlSchema.findOne({
    Request: ReceiptCompleteRequest,
    Result: ReceiptCompletionResult,
    execute: (request) => sql`
      SELECT COALESCE(fidy_complete_whatsapp_receipt(
        ${request.providerMessageId}, ${request.claimId}, ${request.completedAt}
      ), false) AS completed
    `,
  })({ providerMessageId: claim.providerMessageId, claimId: claim.claimId, completedAt }).pipe(
    Effect.orDie
  );
  if (!result.completed) return yield* new WhatsAppReceiptInvalid();
});

const EnqueueRequest = Schema.Struct({
  inboundJobId: WhatsAppInboundJobId,
  userId: UserId,
  providerMessageId: WhatsAppProviderMessageId,
  deliveryKey: WhatsAppDeliveryKey,
  text: InboundMessage.fields.text,
  occurredAt: Schema.DateTimeUtcFromDate,
  enqueuedAt: Schema.DateTimeUtcFromDate,
  debounceUntil: Schema.DateTimeUtcFromDate,
  identityVerifiedAt: Schema.DateTimeUtcFromDate,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
  businessPortfolioId: WhatsAppCaller.fields.businessPortfolioId,
  businessScopedUserId: WhatsAppCaller.fields.businessScopedUserId,
  windowOpenUntil: Schema.DateTimeUtcFromDate,
  traceVersion: Schema.OptionFromNullOr(Schema.Literal(1)),
  traceId: Schema.OptionFromNullOr(DurableTraceContext.fields.traceId),
  parentSpanId: Schema.OptionFromNullOr(DurableTraceContext.fields.parentSpanId),
  traceSampled: Schema.OptionFromNullOr(Schema.Boolean),
  traceCapturedAt: Schema.OptionFromNullOr(DurableTraceContext.fields.capturedAtUnixMilliseconds),
});
const EnqueueResult = Schema.Struct({
  status: Schema.Literals(["enqueued", "duplicate", "stale_authority", "capacity_exceeded"]),
});

type VerifiedWhatsAppIdentity = WhatsAppCallerReference &
  Readonly<{ readonly verifiedAt: DateTime.Utc }>;

const identifiesSameCaller = (
  identity: WhatsAppCallerReference,
  caller: WhatsAppCallerReference
): boolean =>
  identity.businessPortfolioId === caller.businessPortfolioId &&
  identity.businessScopedUserId === caller.businessScopedUserId;

const authorizesEvent = (
  identity: VerifiedWhatsAppIdentity,
  event: WhatsAppInboundEvent
): boolean =>
  identifiesSameCaller(identity, event.caller) &&
  DateTime.Order(event.occurredAt, identity.verifiedAt) >= 0;

const hasCurrentAuthority = (
  identity: VerifiedWhatsAppIdentity,
  event: WhatsAppInboundEvent,
  consentExisted: boolean
): boolean => consentExisted && authorizesEvent(identity, event);

type EnqueueStatement = (
  sql: SqlClient.SqlClient,
  row: typeof EnqueueRequest.Encoded
) => Statement.Statement<SqlConnection.Row>;

const enqueueStatement: EnqueueStatement = (sql, row) => sql`
  WITH existing AS (
    SELECT 1 FROM whatsapp_message_evidence
    WHERE provider_message_id = ${row.providerMessageId}
  ), capacity AS (
    SELECT
      count(job.id) < 32
      AND COALESCE(sum(char_length(job.content)), 0)
        + char_length(${row.text}) + count(job.id) <= 16000
      AS available
    FROM (SELECT 1) AS capacity_check
    LEFT JOIN whatsapp_inbound_jobs AS job
      ON job.user_id = ${row.userId} AND job.completed_at IS NULL
  ), evidence AS (
    INSERT INTO whatsapp_message_evidence(
      provider_message_id, user_id, direction, delivery_key, occurred_at
    )
    SELECT ${row.providerMessageId}, ${row.userId}, 'inbound', ${row.deliveryKey}, ${row.occurredAt}
    WHERE NOT EXISTS (SELECT 1 FROM existing)
      AND (SELECT available FROM capacity)
    ON CONFLICT (provider_message_id) DO NOTHING
    RETURNING id
  ), inserted_job AS (
    INSERT INTO whatsapp_inbound_jobs(
      id, user_id, message_evidence_id, content, occurred_at, enqueued_at, debounce_until,
      trace_version, trace_id, parent_span_id, trace_sampled, trace_captured_at
    )
    SELECT ${row.inboundJobId}, ${row.userId}, id, ${row.text}, ${row.occurredAt}, ${row.enqueuedAt},
      ${row.debounceUntil}, ${row.traceVersion}, ${row.traceId}, ${row.parentSpanId},
      ${row.traceSampled}, ${row.traceCapturedAt}
    FROM evidence
    RETURNING id
  ), advanced_window AS (
    INSERT INTO whatsapp_conversation_windows(
      user_id, identity_verified_at, business_phone_number_id,
      business_portfolio_id, business_scoped_user_id, window_open_until
    )
    SELECT ${row.userId}, ${row.identityVerifiedAt}, ${row.businessPhoneNumberId},
      ${row.businessPortfolioId}, ${row.businessScopedUserId}, ${row.windowOpenUntil}
    FROM evidence
    ON CONFLICT (user_id) DO UPDATE SET
      identity_verified_at = EXCLUDED.identity_verified_at,
      business_phone_number_id = EXCLUDED.business_phone_number_id,
      business_portfolio_id = EXCLUDED.business_portfolio_id,
      business_scoped_user_id = EXCLUDED.business_scoped_user_id,
      window_open_until = CASE
        WHEN whatsapp_conversation_windows.identity_verified_at = EXCLUDED.identity_verified_at
          AND whatsapp_conversation_windows.business_portfolio_id = EXCLUDED.business_portfolio_id
          AND whatsapp_conversation_windows.business_scoped_user_id = EXCLUDED.business_scoped_user_id
        THEN GREATEST(whatsapp_conversation_windows.window_open_until, EXCLUDED.window_open_until)
        ELSE EXCLUDED.window_open_until
      END
  )
  SELECT CASE WHEN EXISTS(SELECT 1 FROM inserted_job) THEN 'enqueued'
    WHEN EXISTS(SELECT 1 FROM existing) THEN 'duplicate'
    ELSE 'capacity_exceeded' END AS status
`;

const enqueueInboundJob = (
  sql: SqlClient.SqlClient
): ((
  request: typeof EnqueueRequest.Type
) => Effect.Effect<
  typeof EnqueueResult.Type,
  Cause.NoSuchElementError | Schema.SchemaError | SqlError.SqlError
>) =>
  SqlSchema.findOne({
    Request: EnqueueRequest,
    Result: EnqueueResult,
    execute: (row) => enqueueStatement(sql, row),
  });

const propagationColumns = (
  propagation: Option.Option<DurableTraceContext>
): Pick<
  typeof EnqueueRequest.Type,
  "traceVersion" | "traceId" | "parentSpanId" | "traceSampled" | "traceCapturedAt"
> => ({
  traceVersion: Option.map(propagation, (context) => context.version),
  traceId: Option.map(propagation, (context) => context.traceId),
  parentSpanId: Option.map(propagation, (context) => context.parentSpanId),
  traceSampled: Option.map(propagation, (context) => context.sampled),
  traceCapturedAt: Option.map(propagation, (context) => context.capturedAtUnixMilliseconds),
});

type EnqueueWhatsAppTurnInput = Readonly<{
  admission: AuthorizedAgentTurn;
  event: WhatsAppInboundEvent;
  deliveryKey: WhatsAppDeliveryKey;
  propagation: Option.Option<DurableTraceContext>;
}>;

const publishWhatsAppInbound = Effect.fn(function* (work: WhatsAppInboundWork) {
  const queue = yield* whatsappInboundQueue;
  yield* queue.offer(work, { id: work.inboundJobId }).pipe(Effect.orDie);
});
const publishAcceptedWhatsAppInbound = Effect.fn(function* (
  status: typeof EnqueueResult.Type.status,
  work: WhatsAppInboundWork
) {
  if (status === "enqueued") yield* publishWhatsAppInbound(work);
});

/**
 * Under current onboarding consent, atomically deduplicates by provider-message evidence, admits
 * at most 32 pending messages/16,000 characters, advances the quiet period and matching recipient
 * window, and returns whether a job was inserted. Propagation must be complete validated context
 * captured by the surrounding publication span or explicitly absent. Capacity refusal fails with
 * WhatsAppInboundCapacityExceeded so the provider may retry.
 */
export const enqueueWhatsAppTurn = Effect.fn("WhatsApp.enqueueTurn")(function* (
  input: EnqueueWhatsAppTurnInput
) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const { admission, propagation } = input;
  const inboundJobId = WhatsAppInboundJobId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  return yield* withUserTransaction(
    admission.userId,
    withUserLockInScope(
      advisoryLockKey.whatsAppBurst(admission.userId),
      useCurrentConsent(
        admission.userId,
        () => new OnboardingConsentRequired({ userId: admission.userId }),
        Effect.gen(function* () {
          const identity = yield* findAndLockWhatsAppIdentity(admission.userId);
          const consentExisted = yield* hasCurrentOnboardingConsentAt(
            admission.userId,
            input.event.occurredAt
          );
          if (Option.isNone(identity)) return { status: "stale_authority" as const };
          if (!hasCurrentAuthority(identity.value, input.event, consentExisted)) {
            return { status: "stale_authority" as const };
          }
          const result = yield* enqueueInboundJob(sql)({
            inboundJobId,
            userId: admission.userId,
            providerMessageId: input.event.messageEvidence.providerMessageId,
            deliveryKey: input.deliveryKey,
            text: admission.inboundMessage.text,
            occurredAt: input.event.occurredAt,
            enqueuedAt: input.event.receivedAt,
            debounceUntil: DateTime.add(input.event.receivedAt, { milliseconds: 2_500 }),
            identityVerifiedAt: identity.value.verifiedAt,
            businessPhoneNumberId: input.event.businessPhoneNumberId,
            businessPortfolioId: input.event.caller.businessPortfolioId,
            businessScopedUserId: input.event.caller.businessScopedUserId,
            windowOpenUntil: DateTime.add(input.event.occurredAt, { hours: 24 }),
            ...propagationColumns(propagation),
          }).pipe(Effect.orDie);
          yield* publishAcceptedWhatsAppInbound(result.status, {
            version: 1,
            userId: admission.userId,
            inboundJobId,
          });
          return result;
        })
      )
    )
  ).pipe(
    Effect.flatMap((result) =>
      result.status === "capacity_exceeded"
        ? Effect.fail(new WhatsAppInboundCapacityExceeded())
        : Effect.succeed({ inserted: result.status === "enqueued" })
    )
  );
});

const StoredInboundJob = Schema.Struct({
  id: WhatsAppInboundJobId,
  text: InboundMessage.fields.text,
  providerMessageId: WhatsAppProviderMessageId,
  occurredAt: Schema.DateTimeUtcFromDate,
  enqueuedAt: Schema.DateTimeUtcFromDate,
  traceVersion: Schema.OptionFromNullOr(Schema.Unknown),
  traceId: Schema.OptionFromNullOr(Schema.Unknown),
  parentSpanId: Schema.OptionFromNullOr(Schema.Unknown),
  traceSampled: Schema.OptionFromNullOr(Schema.Unknown),
  traceCapturedAt: Schema.OptionFromNullOr(Schema.Unknown),
  processingAttempt: TelemetryAttempt,
});
const StoredDurableTraceContext = Schema.Struct({
  version: DurableTraceContext.fields.version,
  traceId: DurableTraceContext.fields.traceId,
  parentSpanId: DurableTraceContext.fields.parentSpanId,
  sampled: DurableTraceContext.fields.sampled,
  capturedAtUnixMilliseconds: Schema.FiniteFromString.pipe(
    Schema.decodeTo(DurableTraceContext.fields.capturedAtUnixMilliseconds)
  ),
});
type StoredInboundJob = typeof StoredInboundJob.Type;

const durableContextFromJob = (job: StoredInboundJob): Option.Option<DurableTraceContext> =>
  Option.all({
    version: job.traceVersion,
    traceId: job.traceId,
    parentSpanId: job.parentSpanId,
    sampled: job.traceSampled,
    capturedAtUnixMilliseconds: job.traceCapturedAt,
  }).pipe(Option.flatMap(Schema.decodeUnknownOption(StoredDurableTraceContext)));

const PreviousOutboundEvidence = Schema.Struct({
  providerMessageId: WhatsAppProviderMessageId,
});

const loadConfirmationOutboundEvidence = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  digest: ConfirmationDigest
) {
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: UserId, digest: ConfirmationDigest }),
    Result: PreviousOutboundEvidence,
    execute: (request) => sql`
      SELECT provider_message_id AS "providerMessageId"
      FROM whatsapp_message_evidence
      WHERE user_id = ${request.userId} AND direction = 'outbound'
        AND confirmation_digest = ${request.digest}
      LIMIT 1
    `,
  })({ userId, digest });
});

const WhatsAppTurnWork = Schema.Struct({ userId: UserId, turnId: TranscriptTurnId });
export type WhatsAppTurnWork = typeof WhatsAppTurnWork.Type;

const loadBurstJobs = Effect.fn(function* (sql: SqlClient.SqlClient, turn: WhatsAppTurnWork) {
  return yield* SqlSchema.findAll({
    Request: WhatsAppTurnWork,
    Result: StoredInboundJob,
    execute: (row) => sql`
      SELECT job.id, job.content AS text, evidence.provider_message_id AS "providerMessageId",
        evidence.occurred_at AS "occurredAt", job.enqueued_at AS "enqueuedAt",
        job.trace_version AS "traceVersion", job.trace_id AS "traceId",
        job.parent_span_id AS "parentSpanId", job.trace_sampled AS "traceSampled",
        job.trace_captured_at AS "traceCapturedAt",
        job.processing_attempt AS "processingAttempt"
      FROM whatsapp_inbound_jobs AS job
      JOIN whatsapp_message_evidence AS evidence ON evidence.id = job.message_evidence_id
      WHERE job.user_id = ${row.userId} AND job.turn_id = ${row.turnId}
        AND job.completed_at IS NULL AND job.content IS NOT NULL
      ORDER BY job.enqueued_at, evidence.id
    `,
  })(turn);
});

const prepareBurst = Effect.fn(function* (input: {
  turn: WhatsAppTurnWork;
  preparedAt: DateTime.Utc;
  jobs: EffectArray.NonEmptyReadonlyArray<StoredInboundJob>;
  previousOutbound: Option.Option<typeof PreviousOutboundEvidence.Type>;
}) {
  const { jobs, preparedAt, previousOutbound, turn } = input;
  const newest = EffectArray.lastNonEmpty(jobs);
  const confirmationEvidence = Option.map(previousOutbound, ({ providerMessageId }) => ({
    _tag: "ProviderQualifiedMessages" as const,
    disclosureMessage: { channel: "whatsapp" as const, provider: "kapso", providerMessageId },
    decisionMessage: {
      channel: "whatsapp" as const,
      provider: "kapso",
      providerMessageId: newest.providerMessageId,
    },
  }));
  const inboundMessage = yield* Schema.decodeEffect(InboundMessage)({
    text: jobs.map(({ text }) => text).join("\n"),
    ...Option.match(confirmationEvidence, {
      onNone: () => ({}),
      onSome: (evidence) => ({ confirmationEvidence: evidence }),
    }),
  });
  return {
    _tag: "Ready" as const,
    turn,
    inboundMessage,
    messages: jobs,
    propagation: durableContextFromJob(newest),
    inputCount: jobs.length,
    processingAttempt: TelemetryAttempt.make(Math.max(...jobs.map((job) => job.processingAttempt))),
    queueDelayMilliseconds: TelemetryDuration.make(
      Math.min(
        maximumQueueDelayMilliseconds,
        Math.max(0, DateTime.toEpochMillis(preparedAt) - DateTime.toEpochMillis(newest.enqueuedAt))
      )
    ),
  };
});

const TriggerState = Schema.Struct({
  turnId: Schema.OptionFromNullOr(TranscriptTurnId),
  completed: Schema.Boolean,
});

/** Confirms identifier-only durable routing against the explicit User before Cluster publication. */
export const ownsWhatsAppInboundWork = Effect.fn("WhatsApp.ownsInboundWork")(function* (
  work: WhatsAppInboundWork
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withUserTransaction(
    work.userId,
    SqlSchema.findOneOption({
      Request: WhatsAppInboundWork,
      Result: Schema.Struct({ present: Schema.Boolean }),
      execute: (row) => sql`SELECT true AS present FROM whatsapp_inbound_jobs
        WHERE user_id = ${row.userId} AND id = ${row.inboundJobId}`,
    })(work).pipe(Effect.map(Option.isSome), Effect.catchTag("SqlError", Effect.die))
  );
});
const QuietPeriod = Schema.Struct({
  debounceUntil: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
});

const loadWhatsAppTrigger = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  work: WhatsAppInboundWork
) {
  return yield* SqlSchema.findOneOption({
    Request: WhatsAppInboundWork,
    Result: TriggerState,
    execute: (row) => sql`
      SELECT turn_id AS "turnId", completed_at IS NOT NULL AS completed
      FROM whatsapp_inbound_jobs
      WHERE user_id = ${row.userId} AND id = ${row.inboundJobId}
      FOR UPDATE
    `,
  })(work);
});

/**
 * Under the explicit User scope, either observes terminal work, returns the current quiet-period
 * deadline, or durably binds every currently pending ordered message to one stable Turn identity.
 * The User-keyed Cluster entity serializes callers; the transaction preserves burst membership
 * across process loss without a claim, lease, or execution deadline.
 */
export const prepareWhatsAppTurn = Effect.fn("WhatsApp.prepareTurn")(function* (
  work: WhatsAppInboundWork,
  now: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withUserTransaction(
    work.userId,
    withUserLockInScope(
      advisoryLockKey.whatsAppBurst(work.userId),
      Effect.gen(function* () {
        const trigger = yield* loadWhatsAppTrigger(sql, work);
        if (Option.isNone(trigger) || trigger.value.completed) return { _tag: "Settled" as const };
        const turnId = Option.getOrElse(trigger.value.turnId, () =>
          TranscriptTurnId.make(work.inboundJobId)
        );
        if (Option.isNone(trigger.value.turnId)) {
          const quiet = yield* SqlSchema.findOne({
            Request: UserId,
            Result: QuietPeriod,
            execute: (userId) => sql`
            SELECT max(debounce_until) AS "debounceUntil"
            FROM whatsapp_inbound_jobs
            WHERE user_id = ${userId} AND completed_at IS NULL AND turn_id IS NULL
          `,
          })(work.userId);
          if (
            Option.isSome(quiet.debounceUntil) &&
            DateTime.Order(now, quiet.debounceUntil.value) < 0
          ) {
            return { _tag: "Wait" as const, until: quiet.debounceUntil.value };
          }
          yield* sql`
          UPDATE whatsapp_inbound_jobs SET turn_id = ${turnId}
          WHERE user_id = ${work.userId} AND completed_at IS NULL AND turn_id IS NULL
        `;
        }
        const selectedTurn = WhatsAppTurnWork.make({ userId: work.userId, turnId });
        yield* sql`UPDATE whatsapp_inbound_jobs
        SET processing_attempt = processing_attempt + 1
        WHERE user_id = ${work.userId} AND turn_id = ${turnId}
          AND completed_at IS NULL AND content IS NOT NULL`;
        const jobs = yield* loadBurstJobs(sql, selectedTurn);
        if (!EffectArray.isArrayNonEmpty(jobs)) return { _tag: "Settled" as const };
        const command = jobs.map(({ text }) => text).join("\n");
        const previousOutbound = yield* confirmationDigestFromCommand(command).pipe(
          Option.match({
            onNone: () => Effect.succeed(Option.none()),
            onSome: (digest) => loadConfirmationOutboundEvidence(sql, work.userId, digest),
          })
        );
        return yield* prepareBurst({ turn: selectedTurn, preparedAt: now, jobs, previousOutbound });
      }).pipe(Effect.catchTag("SqlError", Effect.die))
    )
  );
});

const settleWhatsAppTurn = Effect.fn(function* (
  turn: WhatsAppTurnWork,
  settledAt: DateTime.Utc,
  outcome: "delivered" | "agent_failed" | "send_failed" | "ambiguous_crash"
) {
  const sql = yield* SqlClient.SqlClient;
  yield* withUserTransaction(
    turn.userId,
    sql`
      UPDATE whatsapp_inbound_jobs
      SET content = NULL, completed_at = ${settledAt}, terminal_outcome = ${outcome}
      WHERE user_id = ${turn.userId} AND turn_id = ${turn.turnId}
        AND completed_at IS NULL
    `.pipe(Effect.asVoid, Effect.catchTag("SqlError", Effect.die))
  );
});

/** Removes transient content only after the selected burst has a successfully delivered reply. */
export const completeWhatsAppTurn = Effect.fn("WhatsApp.completeTurn")(function* (
  turn: WhatsAppTurnWork,
  completedAt: DateTime.Utc
) {
  yield* settleWhatsAppTurn(turn, completedAt, "delivered");
});

/** Retires one selected burst with metadata-only failure evidence and no provider replay. */
export const failWhatsAppTurn = Effect.fn("WhatsApp.failTurn")(function* (
  turn: WhatsAppTurnWork,
  failedAt: DateTime.Utc,
  safeReason: "agent_failed" | "send_failed" | "ambiguous_crash"
) {
  yield* settleWhatsAppTurn(turn, failedAt, safeReason);
});

const WindowRow = Schema.Struct({ windowOpenUntil: Schema.DateTimeUtcFromDate });
/**
 * Reads constructive WhatsApp free-form policy state at `now`. The window remains open when `now`
 * equals its deadline. A missing current Identity, an Identity whose
 * verification time differs from the retained window, or a missing/expired window returns
 * `Closed` without disclosing an earlier deadline.
 */
export const getWhatsAppWindowState = Effect.fn("WhatsApp.getWindowState")(function* (
  userId: UserId,
  now: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const window = yield* withUserTransaction(
    userId,
    Effect.gen(function* () {
      const identity = yield* findAndLockWhatsAppIdentity(userId);
      if (Option.isNone(identity)) return Option.none<typeof WindowRow.Type>();
      return yield* SqlSchema.findOneOption({
        Request: OutboundWindowRequest,
        Result: WindowRow,
        execute: (request) => sql`
          SELECT window_open_until AS "windowOpenUntil"
          FROM whatsapp_conversation_windows
          WHERE user_id = ${request.userId}
            AND identity_verified_at = ${request.identityVerifiedAt}
            AND business_portfolio_id = ${identity.value.businessPortfolioId}
            AND business_scoped_user_id = ${identity.value.businessScopedUserId}
        `,
      })({ userId, identityVerifiedAt: identity.value.verifiedAt }).pipe(Effect.orDie);
    })
  );
  if (Option.isNone(window)) return { _tag: "Closed", lastWindowOpenUntil: Option.none() } as const;
  return DateTime.Order(now, window.value.windowOpenUntil) <= 0
    ? ({ _tag: "Open", windowOpenUntil: window.value.windowOpenUntil } as const)
    : ({ _tag: "Closed", lastWindowOpenUntil: Option.some(window.value.windowOpenUntil) } as const);
});

const OutboundEvidenceRequest = Schema.Struct({
  userId: UserId,
  providerMessageId: WhatsAppProviderMessageId,
  occurredAt: Schema.DateTimeUtcFromDate,
  confirmationDigest: Schema.OptionFromNullOr(ConfirmationDigest),
});
/**
 * Retains metadata-only evidence for a successfully decoded outbound provider send. Fails with
 * WhatsAppEvidenceConflict when that provider id is already attributed to different evidence.
 */
export const retainOutboundEvidence = Effect.fn("WhatsApp.retainOutboundEvidence")(function* (
  input: Readonly<{
    userId: UserId;
    message: WhatsAppMessageEvidence;
    occurredAt: DateTime.Utc;
    confirmationDigest: Option.Option<ConfirmationDigest>;
  }>
) {
  const { userId, message, occurredAt, confirmationDigest } = input;
  const sql = yield* SqlClient.SqlClient;
  const retained = yield* withUserTransaction(
    userId,
    SqlSchema.findOneOption({
      Request: OutboundEvidenceRequest,
      Result: Schema.Struct({ retained: Schema.Boolean }),
      execute: (request) => sql`
        INSERT INTO whatsapp_message_evidence(
          provider_message_id, user_id, direction, occurred_at, confirmation_digest
        ) VALUES (
          ${request.providerMessageId}, ${request.userId}, 'outbound', ${request.occurredAt},
          ${request.confirmationDigest}
        )
        ON CONFLICT (provider_message_id) DO NOTHING
        RETURNING true AS retained
      `,
    })({
      userId,
      providerMessageId: message.providerMessageId,
      occurredAt,
      confirmationDigest,
    }).pipe(Effect.orDie)
  );
  if (Option.isNone(retained)) return yield* new WhatsAppEvidenceConflict();
});

const OutboundWindowRequest = Schema.Struct({
  userId: UserId,
  identityVerifiedAt: Schema.DateTimeUtcFromDate,
});
const OutboundWindow = Schema.Struct({
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
  windowOpenUntil: Schema.DateTimeUtcFromDate,
});
/**
 * Requires current onboarding consent and returns only the current WhatsAppIdentity's matching
 * open recipient window. Missing identity fails WhatsAppIdentityMissing; absent, mismatched, or
 * expired state fails WhatsAppWindowClosed.
 */
export const authorizeWhatsAppFreeForm = Effect.fn("WhatsApp.authorizeFreeForm")(function* (
  userId: UserId,
  now: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withUserTransaction(
    userId,
    useCurrentConsent(
      userId,
      () => new OnboardingConsentRequired({ userId }),
      Effect.gen(function* () {
        const identity = yield* findAndLockWhatsAppIdentity(userId);
        if (Option.isNone(identity)) return yield* new WhatsAppIdentityMissing({ userId });
        const phoneNumber = identity.value.phoneNumber;
        const window = yield* SqlSchema.findOneOption({
          Request: OutboundWindowRequest,
          Result: OutboundWindow,
          execute: (request) => sql`
            SELECT business_phone_number_id AS "businessPhoneNumberId",
              window_open_until AS "windowOpenUntil"
            FROM whatsapp_conversation_windows
            WHERE user_id = ${request.userId}
              AND identity_verified_at = ${request.identityVerifiedAt}
              AND business_portfolio_id = ${identity.value.businessPortfolioId}
              AND business_scoped_user_id = ${identity.value.businessScopedUserId}
          `,
        })({ userId, identityVerifiedAt: identity.value.verifiedAt }).pipe(Effect.orDie);
        if (Option.isNone(window)) {
          return yield* new WhatsAppWindowClosed({
            userId,
            lastWindowOpenUntil: Option.none(),
          });
        }
        const { businessPhoneNumberId, windowOpenUntil } = window.value;
        if (DateTime.Order(now, windowOpenUntil) > 0) {
          return yield* new WhatsAppWindowClosed({
            userId,
            lastWindowOpenUntil: Option.some(windowOpenUntil),
          });
        }
        return {
          caller: {
            businessPortfolioId: identity.value.businessPortfolioId,
            businessScopedUserId: identity.value.businessScopedUserId,
            parentBusinessScopedUserId: identity.value.parentBusinessScopedUserId,
            username: identity.value.username,
            phoneNumber,
          },
          businessPhoneNumberId,
          windowOpenUntil,
        };
      })
    )
  );
});
