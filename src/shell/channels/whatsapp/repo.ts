import { Array as EffectArray, Crypto, Data, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { InboundMessage, OnboardingConsentRequired } from "~/shell/agent/agent-service";
import type { AgentConversationAdmission } from "~/shell/agent/conversation";
import { hasCurrentOnboardingConsentAt, useCurrentConsent } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { findAndLockWhatsAppIdentity } from "~/shell/identity/repo";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppCaller,
  WhatsAppDeliveryKey,
  WhatsAppProviderMessageId,
  type WhatsAppInboundEvent,
  type WhatsAppMessageEvidence,
} from "./model";

/** Opaque identity for one durable attempt to process a User's due burst. */
export const WhatsAppClaimId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("WhatsAppClaimId")
);
export type WhatsAppClaimId = typeof WhatsAppClaimId.Type;

const WhatsAppReceiptClaimId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("WhatsAppReceiptClaimId")
);
type WhatsAppReceiptClaimId = typeof WhatsAppReceiptClaimId.Type;
type WhatsAppReceiptClaim = Readonly<{
  readonly providerMessageId: WhatsAppProviderMessageId;
  readonly claimId: WhatsAppReceiptClaimId;
}>;

/** Minimal pre-subject claim projection; message content requires User context. */
export type WhatsAppTurnClaim = Readonly<{
  readonly claimId: WhatsAppClaimId;
  readonly userId: UserId;
  readonly action: "process" | "retire_ambiguous";
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
}> {}
/** The claimed burst no longer exists in the expected claim lifecycle state. */
export class WhatsAppClaimInvalid extends Data.TaggedError("WhatsAppClaimInvalid")<{}> {}
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
  budgetKey: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(256)),
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
});
const EnqueueResult = Schema.Struct({
  status: Schema.Literals(["enqueued", "duplicate", "stale_authority", "capacity_exceeded"]),
});

/**
 * Under current onboarding consent, atomically deduplicates by provider-message evidence, admits
 * at most 32 pending messages/16,000 characters, advances the quiet period and matching recipient
 * window, and returns whether a job was inserted. Capacity refusal fails with
 * WhatsAppInboundCapacityExceeded so the provider may retry.
 */
export const enqueueWhatsAppTurn = Effect.fn("WhatsApp.enqueueTurn")(function* (input: {
  readonly admission: Extract<AgentConversationAdmission, { readonly _tag: "AuthorizedTurn" }>;
  readonly event: WhatsAppInboundEvent;
  readonly deliveryKey: WhatsAppDeliveryKey;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { admission } = input;
  const debounceUntil = DateTime.add(input.event.receivedAt, { milliseconds: 2_500 });
  const windowOpenUntil = DateTime.add(input.event.occurredAt, { hours: 24 });
  return yield* withUserTransaction(
    admission.userId,
    useCurrentConsent(
      admission.userId,
      () => new OnboardingConsentRequired({ userId: admission.userId }),
      Effect.gen(function* () {
        const identity = yield* findAndLockWhatsAppIdentity(admission.userId);
        const consentExisted = yield* hasCurrentOnboardingConsentAt(
          admission.userId,
          input.event.occurredAt
        );
        if (
          Option.isNone(identity) ||
          identity.value.businessPortfolioId !== input.event.caller.businessPortfolioId ||
          identity.value.businessScopedUserId !== input.event.caller.businessScopedUserId ||
          DateTime.Order(input.event.occurredAt, identity.value.verifiedAt) < 0 ||
          !consentExisted
        ) {
          return { status: "stale_authority" as const };
        }
        return yield* SqlSchema.findOne({
          Request: EnqueueRequest,
          Result: EnqueueResult,
          execute: (row) => sql`
          WITH admission_lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtextextended(${row.userId}::text, 0))
          ), existing AS (
            SELECT 1 FROM whatsapp_message_evidence, admission_lock
            WHERE provider_message_id = ${row.providerMessageId}
          ), capacity AS (
            SELECT
              count(job.id) < 32
              AND COALESCE(sum(char_length(job.content)), 0)
                + char_length(${row.text}) + count(job.id) <= 16000
              AS available
            FROM admission_lock
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
              user_id, message_evidence_id, content, occurred_at, enqueued_at, debounce_until
            )
            SELECT ${row.userId}, id, ${row.text}, ${row.occurredAt},
              ${row.enqueuedAt}, ${row.debounceUntil}
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
          SELECT CASE
            WHEN EXISTS(SELECT 1 FROM inserted_job) THEN 'enqueued'
            WHEN EXISTS(SELECT 1 FROM existing) THEN 'duplicate'
            ELSE 'capacity_exceeded'
          END AS status
        `,
        })({
          userId: admission.userId,
          providerMessageId: input.event.messageEvidence.providerMessageId,
          deliveryKey: input.deliveryKey,
          text: admission.inboundMessage.text,
          occurredAt: input.event.occurredAt,
          enqueuedAt: input.event.receivedAt,
          debounceUntil,
          identityVerifiedAt: identity.value.verifiedAt,
          businessPhoneNumberId: input.event.businessPhoneNumberId,
          businessPortfolioId: input.event.caller.businessPortfolioId,
          businessScopedUserId: input.event.caller.businessScopedUserId,
          windowOpenUntil,
        }).pipe(Effect.orDie);
      })
    )
  ).pipe(
    Effect.flatMap((result) =>
      result.status === "capacity_exceeded"
        ? Effect.fail(new WhatsAppInboundCapacityExceeded())
        : Effect.succeed({ inserted: result.status === "enqueued" })
    )
  );
});

const ClaimRow = Schema.Struct({
  claimId: WhatsAppClaimId,
  userId: UserId,
  action: Schema.Literals(["process", "retire_ambiguous"]),
});
/**
 * Atomically claims one globally due User without exposing content. Returns none when no work is
 * due; otherwise the action directs the caller either to process a new claim or retire an expired
 * started claim.
 */
export const claimWhatsAppTurn = (now: DateTime.Utc) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: Schema.DateTimeUtcFromDate,
      Result: ClaimRow,
      execute: (claimTime) => sql`
        SELECT claim_id AS "claimId", subject_user_id AS "userId", claim_action AS action
        FROM fidy_claim_whatsapp_turn(${claimTime})
      `,
    })(now)
  ).pipe(Effect.map(Option.map((row) => row satisfies WhatsAppTurnClaim)), Effect.orDie);

const ClaimedJob = Schema.Struct({
  text: InboundMessage.fields.text,
  providerMessageId: WhatsAppProviderMessageId,
});
const LoadClaimRequest = Schema.Struct({ userId: UserId, claimId: WhatsAppClaimId });

/**
 * Starts one claimed lease with a ten-minute ambiguous-crash deadline, loads its non-empty jobs
 * ordered by provider occurrence and internal evidence id, and collapses text with newlines into
 * one bounded InboundMessage. A missing or stale claim fails WhatsAppClaimInvalid.
 */
export const startWhatsAppTurn = Effect.fn("WhatsApp.startTurn")(function* (
  claim: WhatsAppTurnClaim
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withUserTransaction(
    claim.userId,
    sql
      .withTransaction(
        Effect.gen(function* () {
          const started = yield* SqlSchema.findOneOption({
            Request: LoadClaimRequest,
            Result: Schema.Struct({ started: Schema.Boolean }),
            execute: (row) => sql`
            UPDATE whatsapp_turn_claims
            SET status = 'started', started_at = now(),
              claim_expires_at = now() + interval '10 minutes'
            WHERE id = ${row.claimId} AND user_id = ${row.userId} AND status = 'claimed'
            RETURNING true AS started
          `,
          })(claim);
          if (Option.isNone(started)) return yield* new WhatsAppClaimInvalid();
          const jobs = yield* SqlSchema.findAll({
            Request: LoadClaimRequest,
            Result: ClaimedJob,
            execute: (row) => sql`
            SELECT job.content AS text, evidence.provider_message_id AS "providerMessageId"
            FROM whatsapp_inbound_jobs AS job
            JOIN whatsapp_message_evidence AS evidence ON evidence.id = job.message_evidence_id
            WHERE job.user_id = ${row.userId} AND job.claim_id = ${row.claimId}
              AND job.completed_at IS NULL AND job.content IS NOT NULL
            ORDER BY job.occurred_at, evidence.id
          `,
          })(claim);
          if (!EffectArray.isArrayNonEmpty(jobs)) {
            return yield* Effect.die("started WhatsApp claim contained no jobs");
          }
          const joined = jobs.map(({ text }) => text).join("\n");
          const inboundMessage = yield* Schema.decodeUnknownEffect(InboundMessage)({
            text: joined,
          });
          return { claim, inboundMessage, messages: jobs } as const;
        })
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))
  );
});

const retireClaimContent = (
  sql: SqlClient.SqlClient,
  claim: WhatsAppTurnClaim,
  completedAt: DateTime.Utc
) => sql`
  UPDATE whatsapp_inbound_jobs
  SET content = NULL, completed_at = ${completedAt}, claim_id = NULL
  WHERE user_id = ${claim.userId} AND claim_id = ${claim.claimId}
`;

/** Removes transient content after terminal dispatch while retaining metadata evidence. */
export const completeWhatsAppTurn = Effect.fn("WhatsApp.completeTurn")(function* (
  claim: WhatsAppTurnClaim,
  completedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* withUserTransaction(
    claim.userId,
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* retireClaimContent(sql, claim, completedAt);
          yield* sql`
          DELETE FROM whatsapp_turn_claims
          WHERE user_id = ${claim.userId} AND id = ${claim.claimId}
        `;
        })
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))
  );
});

/** Converts terminal processing failure to metadata-only evidence without replay. */
export const failWhatsAppTurn = Effect.fn("WhatsApp.failTurn")(function* (
  claim: WhatsAppTurnClaim,
  failedAt: DateTime.Utc,
  safeReason: "agent_failed" | "send_failed" | "ambiguous_crash"
) {
  const sql = yield* SqlClient.SqlClient;
  yield* withUserTransaction(
    claim.userId,
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* retireClaimContent(sql, claim, failedAt);
          yield* sql`
          UPDATE whatsapp_turn_claims
          SET status = 'failed', failed_at = ${failedAt}, safe_reason = ${safeReason}
          WHERE user_id = ${claim.userId} AND id = ${claim.claimId}
        `;
        })
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))
  );
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
});
/**
 * Retains metadata-only evidence for a successfully decoded outbound provider send. Fails with
 * WhatsAppEvidenceConflict when that provider id is already attributed to different evidence.
 */
export const retainOutboundEvidence = Effect.fn("WhatsApp.retainOutboundEvidence")(function* (
  userId: UserId,
  message: WhatsAppMessageEvidence,
  occurredAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const retained = yield* withUserTransaction(
    userId,
    SqlSchema.findOneOption({
      Request: OutboundEvidenceRequest,
      Result: Schema.Struct({ retained: Schema.Boolean }),
      execute: (request) => sql`
        INSERT INTO whatsapp_message_evidence(
          provider_message_id, user_id, direction, occurred_at
        ) VALUES (${request.providerMessageId}, ${request.userId}, 'outbound', ${request.occurredAt})
        ON CONFLICT (provider_message_id) DO NOTHING
        RETURNING true AS retained
      `,
    })({ userId, providerMessageId: message.providerMessageId, occurredAt }).pipe(Effect.orDie)
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
