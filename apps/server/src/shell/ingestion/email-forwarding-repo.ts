import { UnknownJsonString } from "~/schema-compatibility";
import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { CapturedInterpretationContext } from "~/core/_shared/captured-interpretation-context";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import { Money } from "~/core/_shared/money";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import {
  CapturedFieldIssue,
  type EmailForwardingAddress,
  EmailNeedsReviewItem,
  EmailNeedsReviewReason,
  type RawEmailIngestSample,
  ReceivedEmailContent,
} from "~/core/ingestion/model";
import {
  EmailForwardingAddressId,
  EmailForwardingLocalPart,
  IngestSampleId,
  NeedsReviewItemId,
  ResendReceivedEmailId,
  ResendWebhookDeliveryId,
} from "~/core/ingestion/reference";
import { PaidTier, TrialPeriod } from "~/core/identity/model";
import { UserId } from "~/core/identity/reference";
import { decideEffectiveAccess } from "~/core/identity/rules";
import {
  decideDeferredForwardedEmailActivation,
  emailAllowancePeriod,
} from "~/core/ingestion/rules";
import { TransactionExtraction, type TransactionId } from "~/core/transactions/model";
import { withUserTransaction } from "~/shell/db/user-transaction";

const AddressRow = Schema.Struct({
  id: EmailForwardingAddressId,
  localPart: EmailForwardingLocalPart,
  createdAt: Schema.DateTimeUtcFromDate,
});

const addressFromRow = (row: typeof AddressRow.Type, domain: string): EmailForwardingAddress => ({
  id: row.id,
  address: `${row.localPart}@${domain}`,
  createdAt: row.createdAt,
});

/** Idempotently creates and returns the User's permanent forwarding address. */
export const enableEmailForwardingAddressInScope = Effect.fn("enableEmailForwardingAddressInScope")(
  function* (input: {
    readonly id: EmailForwardingAddressId;
    readonly userId: UserId;
    readonly localPart: EmailForwardingLocalPart;
    readonly domain: string;
    readonly createdAt: DateTime.Utc;
  }) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOne({
      Request: Schema.Struct({
        id: EmailForwardingAddressId,
        userId: UserId,
        localPart: EmailForwardingLocalPart,
        createdAt: Schema.DateTimeUtc,
      }),
      Result: AddressRow,
      execute: (row) => sql`
      INSERT INTO email_forwarding_addresses (id, user_id, local_part, created_at)
      VALUES (${row.id}, ${row.userId}, ${row.localPart}, ${row.createdAt})
      ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
      RETURNING id, local_part AS "localPart", created_at AS "createdAt"
    `,
    })(input).pipe(
      Effect.map((row) => addressFromRow(row, input.domain)),
      Effect.orDie
    );
  }
);

/** Finds the current User's forwarding address while already in User scope. */
export const findEmailForwardingAddressInScope = Effect.fn("findEmailForwardingAddressInScope")(
  function* (userId: UserId, domain: string) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: UserId,
      Result: AddressRow,
      execute: (id) => sql`
      SELECT id, local_part AS "localPart", created_at AS "createdAt"
      FROM email_forwarding_addresses WHERE user_id = ${id}
    `,
    })(userId).pipe(Effect.map(Option.map((row) => addressFromRow(row, domain))), Effect.orDie);
  }
);

/** Resolves an authenticated webhook recipient through the narrow cross-User gateway. */
export const resolveForwardingAddress = Effect.fn("resolveForwardingAddress")(function* (
  localPart: EmailForwardingLocalPart
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: EmailForwardingLocalPart,
    Result: Schema.Struct({ userId: UserId }),
    execute: (value) => sql`
      SELECT resolved AS "userId"
      FROM fidy_resolve_email_forwarding_address(${value}) AS resolved
      WHERE resolved IS NOT NULL
    `,
  })(localPart).pipe(
    Effect.map(Option.flatMap((row) => Option.fromNullOr(row.userId))),
    Effect.orDie
  );
});

const AuthenticatedWebhookAdmission = Schema.Struct({
  disposition: Schema.Literals(["admitted", "rate-exceeded", "replay", "retry"]),
});

const ReceiptAdmissionRow = Schema.Struct({
  receivedEmailId: ResendReceivedEmailId,
  status: Schema.Literals(["accepted", "deferred", "completed", "revoked", "expired"]),
});

/** Deduplicates one proof and charges new delivery against the cross-instance provider budget. */
export const admitAuthenticatedResendWebhookEvent = Effect.fn(
  "admitAuthenticatedResendWebhookEvent"
)(function* (deliveryId: ResendWebhookDeliveryId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: ResendWebhookDeliveryId,
    Result: AuthenticatedWebhookAdmission,
    execute: (id) => sql`
      SELECT fidy_admit_authenticated_resend_webhook(${id}) AS disposition
    `,
  })(deliveryId).pipe(
    Effect.map((row) => row.disposition),
    Effect.orDie
  );
});

/** Marks a delivery complete only after its privacy-uniform downstream disposition is durable. */
export const completeAuthenticatedResendWebhookEvent = Effect.fn(
  "completeAuthenticatedResendWebhookEvent"
)(function* (deliveryId: ResendWebhookDeliveryId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`SELECT fidy_complete_authenticated_resend_webhook(${deliveryId})`.pipe(Effect.orDie);
});

/** Atomically charges shared known-recipient and stable-User provider/model budgets. */
export const admitKnownForwardedEmailInScope = Effect.fn("admitKnownForwardedEmailInScope")(
  function* (userId: UserId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOne({
      Request: UserId,
      Result: Schema.Struct({ admitted: Schema.Boolean }),
      execute: (id) => sql`
        SELECT fidy_admit_known_forwarded_email(${id}) AS admitted
      `,
    })(userId).pipe(
      Effect.map((row) => row.admitted),
      Effect.orDie
    );
  }
);

/** Atomically checks the RLS-spanning global capacity through its narrow database gateway. */
export const hasGlobalForwardedEmailCapacityInScope = Effect.fn(
  "hasGlobalForwardedEmailCapacityInScope"
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ available: Schema.Boolean }),
    execute: () => sql`SELECT fidy_has_global_forwarded_email_capacity() AS available`,
  })(undefined).pipe(
    Effect.map((row) => row.available),
    Effect.orDie
  );
});

/** Locks one User's address so concurrent monthly allowance decisions serialize. */
export const lockEmailForwardingAdmissionInScope = Effect.fn("lockEmailForwardingAdmissionInScope")(
  function* (userId: UserId) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT id FROM email_forwarding_addresses WHERE user_id = ${userId} FOR UPDATE`.pipe(
      Effect.orDie
    );
  }
);

/** Finds prior provider context before charging allowance for a redelivery. */
export const findForwardedEmailReceiptInScope = Effect.fn("findForwardedEmailReceiptInScope")(
  function* (userId: UserId, receivedEmailId: ResendReceivedEmailId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: Schema.Struct({ userId: UserId, receivedEmailId: ResendReceivedEmailId }),
      Result: ReceiptAdmissionRow,
      execute: (row) => sql`
      SELECT received_email_id AS "receivedEmailId", status
      FROM forwarded_email_receipts
      WHERE user_id = ${row.userId} AND received_email_id = ${row.receivedEmailId}
    `,
    })({ userId, receivedEmailId }).pipe(Effect.orDie);
  }
);

/** Counts unique provider emails admitted in one fixed Colombia month. */
export const countForwardedEmailsInPeriodInScope = Effect.fn("countForwardedEmailsInPeriodInScope")(
  function* (userId: UserId, period: Readonly<{ from: DateTime.Utc; toExclusive: DateTime.Utc }>) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOne({
      Request: Schema.Struct({ userId: UserId, from: Schema.DateTimeUtc, to: Schema.DateTimeUtc }),
      Result: Schema.Struct({ count: Schema.Int }),
      execute: (row) => sql`
      SELECT count(*)::int AS count FROM forwarded_email_receipts
      WHERE user_id = ${row.userId} AND consumes_free_allowance
        AND period_start >= ${row.from} AND period_start < ${row.to}
    `,
    })({ userId, from: period.from, to: period.toExclusive }).pipe(
      Effect.map((row) => row.count),
      Effect.orDie
    );
  }
);

/** Counts all nonterminal context subject to the durable per-User pressure bound. */
export const countOutstandingEmailsInScope = Effect.fn("countOutstandingEmailsInScope")(function* (
  userId: UserId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: UserId,
    Result: Schema.Struct({ count: Schema.Int }),
    execute: (id) => sql`
        SELECT count(*)::int AS count FROM forwarded_email_receipts
        WHERE user_id = ${id} AND status IN ('accepted', 'deferred')
      `,
  })(userId).pipe(
    Effect.map((row) => row.count),
    Effect.orDie
  );
});

/** Counts context visibly waiting on the next reset. */
export const countDeferredEmailsInScope = Effect.fn("countDeferredEmailsInScope")(function* (
  userId: UserId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: UserId,
    Result: Schema.Struct({ count: Schema.Int }),
    execute: (id) => sql`
      SELECT count(*)::int AS count FROM forwarded_email_receipts
      WHERE user_id = ${id} AND status = 'deferred'
    `,
  })(userId).pipe(
    Effect.map((row) => row.count),
    Effect.orDie
  );
});

/** Persists one deduplicated provider email under its frozen User interpretation context. */
export const insertForwardedEmailReceiptInScope = Effect.fn("insertForwardedEmailReceiptInScope")(
  function* (input: {
    readonly userId: UserId;
    readonly receivedEmailId: ResendReceivedEmailId;
    readonly webhookDeliveryId: ResendWebhookDeliveryId;
    readonly status: "accepted" | "deferred";
    readonly context: CapturedInterpretationContext;
    readonly periodStart: DateTime.Utc;
    readonly consumesFreeAllowance: boolean;
    readonly resumeAt: Option.Option<DateTime.Utc>;
    readonly admittedAt: DateTime.Utc;
  }) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: Schema.Struct({
        userId: UserId,
        receivedEmailId: ResendReceivedEmailId,
        webhookDeliveryId: ResendWebhookDeliveryId,
        status: Schema.Literals(["accepted", "deferred"]),
        ...CapturedInterpretationContext.fields,
        periodStart: Schema.DateTimeUtc,
        consumesFreeAllowance: Schema.Boolean,
        resumeAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
        admittedAt: Schema.DateTimeUtc,
      }),
      Result: ReceiptAdmissionRow,
      execute: (row) => sql`
      INSERT INTO forwarded_email_receipts (
        received_email_id, user_id, webhook_delivery_id, status, service_market, locale,
        time_zone, period_start, consumes_free_allowance, resume_at, admitted_at
      ) VALUES (
        ${row.receivedEmailId}, ${row.userId}, ${row.webhookDeliveryId}, ${row.status},
        ${row.serviceMarket}, ${row.locale}, ${row.timeZone}, ${row.periodStart},
        ${row.consumesFreeAllowance}, ${row.resumeAt}, ${row.admittedAt}
      ) ON CONFLICT (received_email_id) DO NOTHING
      RETURNING received_email_id AS "receivedEmailId", status
    `,
    })({ ...input, ...input.context }).pipe(Effect.orDie);
  }
);

const ForwardedEmailExecutionContext = Schema.Struct({
  receivedEmailId: ResendReceivedEmailId,
  userId: UserId,
  status: Schema.Literals(["accepted", "deferred"]),
  resumeAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  periodStart: Schema.DateTimeUtcFromDate,
  consumesFreeAllowance: Schema.Boolean,
  ...CapturedInterpretationContext.fields,
  forwardingLocalPart: EmailForwardingLocalPart,
  parserRevision: InterpretationRevision,
});
/** Authoritative User-owned facts required by one actionable forwarded-email workflow. */
export type ForwardedEmailExecutionContext = typeof ForwardedEmailExecutionContext.Type;

const ForwardedEmailLifecycleRow = Schema.Struct({
  receivedEmailId: ResendReceivedEmailId,
  userId: UserId,
  status: Schema.Literals(["accepted", "deferred", "completed", "revoked", "expired"]),
  resumeAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  completedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  periodStart: Schema.DateTimeUtcFromDate,
  consumesFreeAllowance: Schema.Boolean,
  ...CapturedInterpretationContext.fields,
  forwardingLocalPart: Schema.OptionFromNullOr(EmailForwardingLocalPart),
  parserRevision: InterpretationRevision,
});

/** Exhaustive persisted lifecycle; absence means only that no routed receipt exists. */
export type ForwardedEmailReceiptLifecycle =
  | Readonly<{ _tag: "Actionable"; context: ForwardedEmailExecutionContext }>
  | Readonly<{ _tag: "Completed"; completedAt: DateTime.Utc }>
  | Readonly<{ _tag: "Revoked"; completedAt: DateTime.Utc }>
  | Readonly<{ _tag: "Expired"; completedAt: DateTime.Utc }>;

const lifecycleFromRow = (
  row: typeof ForwardedEmailLifecycleRow.Type
): ForwardedEmailReceiptLifecycle => {
  if (row.status === "completed") {
    return { _tag: "Completed", completedAt: Option.getOrThrow(row.completedAt) };
  }
  if (row.status === "revoked") {
    return { _tag: "Revoked", completedAt: Option.getOrThrow(row.completedAt) };
  }
  if (row.status === "expired") {
    return { _tag: "Expired", completedAt: Option.getOrThrow(row.completedAt) };
  }
  return {
    _tag: "Actionable",
    context: {
      ...row,
      status: row.status,
      forwardingLocalPart: Option.getOrThrow(row.forwardingLocalPart),
    },
  };
};

/** Resolves durable receipt ownership without treating workflow identity as authority. */
export const resolveForwardedEmailUser = Effect.fn("resolveForwardedEmailUser")(function* (
  receivedEmailId: ResendReceivedEmailId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: ResendReceivedEmailId,
    Result: Schema.Struct({ userId: UserId }),
    execute: (id) => sql`
      SELECT resolved AS "userId" FROM fidy_resolve_forwarded_email_user(${id}) AS resolved
      WHERE resolved IS NOT NULL
    `,
  })(receivedEmailId).pipe(
    Effect.map(Option.flatMap((row) => Option.fromNullOr(row.userId))),
    Effect.orDie
  );
});

/** Loads the complete receipt lifecycle inside the payload User's RLS scope. */
export const findForwardedEmailReceiptLifecycleInScope = Effect.fn(
  "findForwardedEmailReceiptLifecycleInScope"
)(function* (userId: UserId, receivedEmailId: ResendReceivedEmailId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: UserId, receivedEmailId: ResendReceivedEmailId }),
    Result: ForwardedEmailLifecycleRow,
    execute: (row) => sql`
      SELECT receipt.received_email_id AS "receivedEmailId", receipt.user_id AS "userId",
        receipt.status, receipt.resume_at AS "resumeAt",
        receipt.completed_at AS "completedAt", receipt.period_start AS "periodStart",
        receipt.consumes_free_allowance AS "consumesFreeAllowance",
        receipt.service_market AS "serviceMarket", receipt.locale,
        receipt.time_zone AS "timeZone", address.local_part AS "forwardingLocalPart",
        'notification-email-parser-v1'::text AS "parserRevision"
      FROM forwarded_email_receipts AS receipt
      LEFT JOIN email_forwarding_addresses AS address ON address.user_id = receipt.user_id
      WHERE receipt.user_id = ${row.userId}
        AND receipt.received_email_id = ${row.receivedEmailId}
    `,
  })({ userId, receivedEmailId }).pipe(Effect.map(Option.map(lifecycleFromRow)), Effect.orDie);
});

/** Loads the complete receipt lifecycle inside the payload User's RLS scope. */
export const findForwardedEmailReceiptLifecycle = Effect.fn("findForwardedEmailReceiptLifecycle")(
  function* (userId: UserId, receivedEmailId: ResendReceivedEmailId) {
    return yield* withUserTransaction(
      userId,
      findForwardedEmailReceiptLifecycleInScope(userId, receivedEmailId)
    );
  }
);

const DeferredActivationRequest = Schema.Struct({
  userId: UserId,
  receivedEmailId: ResendReceivedEmailId,
});
const DeferredActivationSnapshot = Schema.Struct({
  paidTier: PaidTier,
  trialStartedAt: Schema.DateTimeUtcFromDate,
  trialEndsAt: Schema.DateTimeUtcFromDate,
  consumed: Schema.Finite,
  resumeAt: Schema.DateTimeUtcFromDate,
});

const lockDeferredActivationSnapshotInScope = Effect.fn("lockDeferredActivationSnapshotInScope")(
  function* (
    input: typeof DeferredActivationRequest.Type,
    period: ReturnType<typeof emailAllowancePeriod>
  ) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: DeferredActivationRequest,
      Result: DeferredActivationSnapshot,
      execute: (request) => sql`
      WITH admission_lock AS MATERIALIZED (
        SELECT id FROM email_forwarding_addresses
        WHERE user_id = ${request.userId}
        FOR UPDATE
      ), subject AS MATERIALIZED (
        SELECT users.id, users.paid_tier, users.trial_started_at, users.trial_ends_at
        FROM users, admission_lock
        WHERE users.id = ${request.userId}
      ), receipt AS MATERIALIZED (
        SELECT resume_at FROM forwarded_email_receipts
        WHERE user_id = ${request.userId}
          AND received_email_id = ${request.receivedEmailId}
          AND status = 'deferred'
        FOR UPDATE
      )
      SELECT subject.paid_tier AS "paidTier",
        subject.trial_started_at AS "trialStartedAt",
        subject.trial_ends_at AS "trialEndsAt",
        (SELECT count(*)::int FROM forwarded_email_receipts
          WHERE user_id = subject.id
            AND consumes_free_allowance
            AND status <> 'deferred'
            AND period_start >= ${period.from}
            AND period_start < ${period.toExclusive}) AS consumed,
        receipt.resume_at AS "resumeAt"
      FROM subject, receipt
    `,
    })(input);
  }
);

/** Atomically applies the core deferred-receipt decision to one locked lifecycle snapshot. */
export const activateDeferredForwardedEmail = Effect.fn("activateDeferredForwardedEmail")(
  function* (context: ForwardedEmailExecutionContext, now: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    const period = emailAllowancePeriod(now);
    yield* withUserTransaction(
      context.userId,
      Effect.gen(function* () {
        const snapshot = yield* lockDeferredActivationSnapshotInScope(
          { userId: context.userId, receivedEmailId: context.receivedEmailId },
          period
        );
        if (Option.isNone(snapshot)) return;
        const access = yield* decideEffectiveAccess(
          {
            paidTier: snapshot.value.paidTier,
            trialPeriod: TrialPeriod.make({
              startedAt: snapshot.value.trialStartedAt,
              endsAt: snapshot.value.trialEndsAt,
            }),
          },
          now
        );
        const decision = decideDeferredForwardedEmailActivation({
          access,
          consumed: snapshot.value.consumed,
          resumeAt: snapshot.value.resumeAt,
          now,
          nextResumeAt: period.toExclusive,
        });
        const activated = decision._tag === "Activate";
        yield* sql`
          UPDATE forwarded_email_receipts
          SET status = ${activated ? "accepted" : "deferred"},
            resume_at = ${activated ? null : decision.resumeAt},
            period_start = ${activated ? period.from : context.periodStart},
            consumes_free_allowance = ${
              decision._tag === "Activate" ? decision.consumesFreeAllowance : true
            }
          WHERE user_id = ${context.userId}
            AND received_email_id = ${context.receivedEmailId}
            AND status = 'deferred'
        `;
      }).pipe(Effect.orDie)
    );
  }
);

/** Fixed page bound shared by the finite startup recovery sweep. */
export const forwardedEmailRecoveryPageSize = 100;

/** Lists one bounded recovery page exposing only execution identity and authoritative ownership. */
export const findPendingForwardedEmailExecutions = Effect.fn("findPendingForwardedEmailExecutions")(
  function* (cursor: Option.Option<ResendReceivedEmailId>) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findAll({
      Request: Schema.OptionFromNullOr(ResendReceivedEmailId),
      Result: Schema.Struct({ receivedEmailId: ResendReceivedEmailId, userId: UserId }),
      execute: (afterReceivedEmailId) => sql`
        SELECT received_email_id AS "receivedEmailId", user_id AS "userId"
        FROM fidy_list_pending_forwarded_email_executions(
          ${afterReceivedEmailId}, ${forwardedEmailRecoveryPageSize}
        )
      `,
    })(cursor).pipe(Effect.orDie);
  }
);

/** Resolves a bounded terminal set before durable execution history is removed. */
export const findExpiredForwardedEmailExecutions = Effect.fn("findExpiredForwardedEmailExecutions")(
  function* (completedBefore: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findAll({
      Request: Schema.DateTimeUtc,
      Result: Schema.Struct({
        receivedEmailId: ResendReceivedEmailId,
        userId: UserId,
        cleanupStartedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
      }),
      execute: (cutoff) => sql`
        SELECT received_email_id AS "receivedEmailId", user_id AS "userId",
          cleanup_started_at AS "cleanupStartedAt"
        FROM fidy_resolve_expired_forwarded_email_executions(${cutoff})
      `,
    })(completedBefore).pipe(Effect.orDie);
  }
);

const ForwardedEmailCleanupRequest = Schema.Struct({
  receivedEmailId: ResendReceivedEmailId,
  userId: UserId,
  observedAt: Schema.DateTimeUtc,
});

/** Defers an ineligible cleanup candidate so one bounded sweep can make fair progress. */
export const markForwardedEmailCleanupChecked = Effect.fn("markForwardedEmailCleanupChecked")(
  function* (input: typeof ForwardedEmailCleanupRequest.Type) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT fidy_mark_forwarded_email_cleanup_checked(
    ${input.receivedEmailId}, ${input.userId}, ${input.observedAt}
  )`.pipe(Effect.orDie);
  }
);

/** Persists proof that Workflow.Complete was observed before destructive cleanup begins. */
export const startForwardedEmailCleanup = Effect.fn("startForwardedEmailCleanup")(function* (
  input: typeof ForwardedEmailCleanupRequest.Type
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: ForwardedEmailCleanupRequest,
    Result: Schema.Struct({ started: Schema.Boolean }),
    execute: (request) => sql`
      SELECT fidy_start_forwarded_email_cleanup(
        ${request.receivedEmailId}, ${request.userId}, ${request.observedAt}
      ) AS started
    `,
  })(input).pipe(
    Effect.map((row) => row.started),
    Effect.orDie
  );
});

/** Marks an idempotent queue-and-Cluster cleanup sequence complete. */
export const completeForwardedEmailCleanup = Effect.fn("completeForwardedEmailCleanup")(function* (
  input: typeof ForwardedEmailCleanupRequest.Type
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`SELECT fidy_complete_forwarded_email_cleanup(
      ${input.receivedEmailId}, ${input.userId}, ${input.observedAt}
    )`.pipe(Effect.orDie);
});

/** Persists one raw sample and its still-personal automatic redaction candidate. */
export const insertRawEmailSampleInScope = Effect.fn("insertRawEmailSampleInScope")(
  function* (input: {
    readonly sample: RawEmailIngestSample;
    readonly userId: UserId;
    readonly encodedContent: string;
    readonly contentHash: string;
    readonly anonymizationCandidate: string;
    readonly anonymizationRevision: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOne({
      Request: Schema.Struct({ id: IngestSampleId }),
      Result: Schema.Struct({ id: IngestSampleId }),
      execute: () => sql`
      INSERT INTO raw_email_ingest_samples (
        id, user_id, received_email_id, service_market, locale, time_zone, source_format,
        source_provider, parser_revision, content, content_hash, anonymization_candidate,
        anonymization_revision, retained_at, expires_at
      ) VALUES (
        ${input.sample.id}, ${input.userId}, ${input.sample.receivedEmailId},
        ${input.sample.serviceMarket}, ${input.sample.locale}, ${input.sample.timeZone},
        ${input.sample.sourceFormat}, ${input.sample.sourceProvider}, ${input.sample.parserRevision},
        ${input.encodedContent}::jsonb, ${input.contentHash}, ${input.anonymizationCandidate},
        ${input.anonymizationRevision}, ${input.sample.retainedAt}, ${input.sample.expiresAt}
      ) ON CONFLICT (received_email_id) DO UPDATE SET received_email_id = EXCLUDED.received_email_id
      RETURNING id
    `,
    })({ id: input.sample.id }).pipe(
      Effect.map((row) => row.id),
      Effect.orDie
    );
  }
);

const ForwardedEmailInterpretation = Schema.Union([
  Schema.TaggedStruct("Extracted", { extraction: TransactionExtraction }),
  Schema.TaggedStruct("InvalidExtraction", {}),
  Schema.TaggedStruct("ModelUnavailable", {}),
]);
type RetainedForwardedEmail = Readonly<{
  id: IngestSampleId;
  content: ReceivedEmailContent;
  contentHash: string;
}>;

/** Loads retained provider material only inside the owning User's activity transaction. */
export const findRetainedForwardedEmailInScope: (
  context: ForwardedEmailExecutionContext
) => Effect.Effect<Option.Option<RetainedForwardedEmail>, never, SqlClient.SqlClient> = Effect.fn(
  "findRetainedForwardedEmailInScope"
)(function* (context: ForwardedEmailExecutionContext) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: UserId, receivedEmailId: ResendReceivedEmailId }),
    Result: Schema.Struct({
      id: IngestSampleId,
      content: Schema.Unknown,
      contentHash: Schema.String,
    }),
    execute: (input) => sql`
      SELECT id, content, content_hash AS "contentHash"
      FROM raw_email_ingest_samples
      WHERE user_id = ${input.userId} AND received_email_id = ${input.receivedEmailId}
    `,
  })(context).pipe(Effect.orDie);
  return yield* Option.match(row, {
    onNone: () => Effect.succeed(Option.none<RetainedForwardedEmail>()),
    onSome: (value) =>
      Schema.decodeUnknownEffect(ReceivedEmailContent)(value.content).pipe(
        Effect.map((content) => Option.some({ ...value, content })),
        Effect.orDie
      ),
  });
});

/** Bounded interpretation retained in User-owned storage until terminal settlement. */
export type ForwardedEmailInterpretation = typeof ForwardedEmailInterpretation.Type;

type PersistedInterpretationOutcome = (
  interpretation: ForwardedEmailInterpretation
) => "extracted" | "invalid-extraction" | "model-unavailable";

const persistedInterpretationOutcome: PersistedInterpretationOutcome = (interpretation) => {
  if (interpretation._tag === "Extracted") return "extracted";
  return interpretation._tag === "InvalidExtraction" ? "invalid-extraction" : "model-unavailable";
};

/** Idempotently retains one model outcome outside generic workflow storage. */
export const storeForwardedEmailInterpretationInScope = Effect.fn(
  "storeForwardedEmailInterpretationInScope"
)(function* (
  context: ForwardedEmailExecutionContext,
  interpretation: ForwardedEmailInterpretation
) {
  const sql = yield* SqlClient.SqlClient;
  const extraction =
    interpretation._tag === "Extracted"
      ? yield* Schema.encodeEffect(UnknownJsonString)(
          yield* Schema.encodeEffect(TransactionExtraction)(interpretation.extraction).pipe(
            Effect.orDie
          )
        ).pipe(Effect.orDie)
      : null;
  const inserted = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ stored: Schema.Boolean }),
    execute: () => sql`
      INSERT INTO forwarded_email_interpretations (
        received_email_id, user_id, outcome, extraction, created_at, expires_at
      )
      SELECT ${context.receivedEmailId}, ${context.userId},
        ${persistedInterpretationOutcome(interpretation)}, ${extraction}::jsonb, now(),
        sample.expires_at
      FROM forwarded_email_receipts AS receipt
      JOIN raw_email_ingest_samples AS sample
        ON sample.received_email_id = receipt.received_email_id
      WHERE receipt.received_email_id = ${context.receivedEmailId}
        AND receipt.user_id = ${context.userId}
        AND receipt.status = 'accepted'
      ON CONFLICT (received_email_id) DO NOTHING
      RETURNING true AS stored
    `,
  })(undefined).pipe(Effect.orDie);
  return Option.isSome(inserted);
});

/** Loads the prepared model outcome while the caller holds User scope. */
export const findForwardedEmailInterpretationInScope = Effect.fn(
  "findForwardedEmailInterpretationInScope"
)(function* (context: ForwardedEmailExecutionContext) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: UserId, receivedEmailId: ResendReceivedEmailId }),
    Result: Schema.Struct({
      outcome: Schema.Literals(["extracted", "invalid-extraction", "model-unavailable"]),
      extraction: Schema.OptionFromNullOr(Schema.Unknown),
    }),
    execute: (input) => sql`
      SELECT outcome, extraction FROM forwarded_email_interpretations
      WHERE user_id = ${input.userId} AND received_email_id = ${input.receivedEmailId}
    `,
  })(context).pipe(Effect.orDie);
  return yield* Option.match(row, {
    onNone: () => Effect.succeed(Option.none<ForwardedEmailInterpretation>()),
    onSome: (value) =>
      value.outcome !== "extracted"
        ? Effect.succeed(
            Option.some(
              value.outcome === "model-unavailable"
                ? ({ _tag: "ModelUnavailable" } as const)
                : ({ _tag: "InvalidExtraction" } as const)
            )
          )
        : Schema.decodeUnknownEffect(TransactionExtraction)(
            Option.getOrThrow(value.extraction)
          ).pipe(
            Effect.map((extraction) => Option.some({ _tag: "Extracted" as const, extraction })),
            Effect.orDie
          ),
  });
});

/** Defers an accepted receipt whose Consent policy basis is no longer current. */
export const deferForwardedEmailForConsentInScope = Effect.fn(
  "deferForwardedEmailForConsentInScope"
)(function* (context: ForwardedEmailExecutionContext) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE forwarded_email_receipts
    SET status = 'deferred', resume_at = ${DateTime.add(yield* DateTime.now, { days: 1 })}
    WHERE user_id = ${context.userId} AND received_email_id = ${context.receivedEmailId}
      AND status = 'accepted'
  `.pipe(Effect.orDie);
});

/** Terminalizes one receipt whose Consent disappeared before durable settlement. */
export const revokeForwardedEmailForConsentInScope = Effect.fn(
  "revokeForwardedEmailForConsentInScope"
)(function* (input: {
  readonly context: ForwardedEmailExecutionContext;
  readonly revokedAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    WITH revoked AS (
      UPDATE forwarded_email_receipts
      SET status = 'revoked', resume_at = NULL, completed_at = ${input.revokedAt}
      WHERE user_id = ${input.context.userId}
        AND received_email_id = ${input.context.receivedEmailId}
        AND status IN ('accepted', 'deferred')
      RETURNING user_id, received_email_id
    ), removed_samples AS (
      DELETE FROM raw_email_ingest_samples AS sample
      USING revoked
      WHERE sample.user_id = revoked.user_id
        AND sample.received_email_id = revoked.received_email_id
    )
    DELETE FROM forwarded_email_interpretations AS interpretation
    USING revoked
    WHERE interpretation.user_id = revoked.user_id
      AND interpretation.received_email_id = revoked.received_email_id
  `.pipe(Effect.orDie);
});

const EmailReviewRow = Schema.Struct({
  id: NeedsReviewItemId,
  receivedEmailId: ResendReceivedEmailId,
  ingestSampleId: Schema.OptionFromNullOr(IngestSampleId),
  reason: EmailNeedsReviewReason,
  knownAmount: Schema.OptionFromNullOr(Money.fields.amount),
  knownCurrency: Schema.OptionFromNullOr(Money.fields.currency),
  ...CapturedInterpretationContext.fields,
  providerMessageId: ProviderMessageEvidence.fields.providerMessageId,
  parserRevision: InterpretationRevision,
  extractorRevision: InterpretationRevision,
  issues: Schema.Array(CapturedFieldIssue),
  status: Schema.Literals(["pending", "expired"]),
  createdAt: Schema.DateTimeUtcFromDate,
});

/** Lists a bounded prefix of visible email review outcomes inside one User transaction. */
export const selectEmailNeedsReviewItemsInScope = Effect.fn("selectEmailNeedsReviewItemsInScope")(
  function* (userId: UserId, limit: number) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Struct({ userId: UserId, limit: Schema.Int }),
      Result: EmailReviewRow,
      execute: (row) => sql`
      SELECT id, received_email_id AS "receivedEmailId", ingest_sample_id AS "ingestSampleId",
        reason, known_amount AS "knownAmount", known_currency AS "knownCurrency",
        service_market AS "serviceMarket", locale, time_zone AS "timeZone",
        provider_message_id AS "providerMessageId", parser_revision AS "parserRevision",
        extractor_revision AS "extractorRevision", issues, status, created_at AS "createdAt"
      FROM email_needs_review_items WHERE user_id = ${row.userId}
      ORDER BY (status = 'pending') DESC, created_at, id LIMIT ${row.limit}
    `,
    })({ userId, limit }).pipe(Effect.orDie);
    return yield* Effect.forEach(rows, (row) => {
      const knownMoney =
        Option.isSome(row.knownAmount) && Option.isSome(row.knownCurrency)
          ? Option.some(
              Money.make({ amount: row.knownAmount.value, currency: row.knownCurrency.value })
            )
          : Option.none();
      const base = {
        id: row.id,
        receivedEmailId: row.receivedEmailId,
        reason: row.reason,
        ...(Option.isSome(knownMoney) ? { knownMoney: knownMoney.value } : {}),
        serviceMarket: row.serviceMarket,
        locale: row.locale,
        timeZone: row.timeZone,
        sourceFormat: "notification-email" as const,
        sourceChannel: "forwarded-email" as const,
        sourceProvider: "resend" as const,
        messageEvidence: {
          channel: "email",
          provider: "resend",
          providerMessageId: row.providerMessageId,
        },
        parserRevision: row.parserRevision,
        extractorRevision: row.extractorRevision,
        issues: row.issues,
        createdAt: DateTime.formatIso(row.createdAt),
      };
      return row.status === "pending"
        ? Schema.decodeUnknownEffect(EmailNeedsReviewItem)({
            ...base,
            status: "pending",
            ...(Option.isSome(row.ingestSampleId)
              ? { ingestSampleId: row.ingestSampleId.value }
              : {}),
          })
        : Schema.decodeUnknownEffect(EmailNeedsReviewItem)({ ...base, status: "expired" });
    });
  }
);

/** Makes one successfully captured Transaction the receipt's sole terminal outcome. */
export const completeForwardedEmailWithTransactionInScope = Effect.fn(
  "completeForwardedEmailWithTransactionInScope"
)(function* (
  context: ForwardedEmailExecutionContext,
  transactionId: TransactionId,
  completedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    WITH completed AS (
      UPDATE forwarded_email_receipts SET status = 'completed',
        transaction_id = ${transactionId}, completed_at = ${completedAt}
      WHERE user_id = ${context.userId} AND received_email_id = ${context.receivedEmailId}
        AND status = 'accepted'
    )
    DELETE FROM forwarded_email_interpretations
    WHERE user_id = ${context.userId} AND received_email_id = ${context.receivedEmailId}
  `.pipe(Effect.orDie);
});

type CompleteForwardedEmailReviewInput = Readonly<{
  context: ForwardedEmailExecutionContext;
  reviewId: NeedsReviewItemId;
  evidence:
    | Readonly<{ _tag: "ProviderMessage"; reason: "provider-retrieval-failed" }>
    | Readonly<{
        _tag: "RawSample";
        sampleId: IngestSampleId;
        reason: "model-unavailable" | "canonical-validation-failed";
        extraction: Option.Option<TransactionExtraction>;
      }>;
  extractorRevision: string;
  issues: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  createdAt: DateTime.Utc;
}>;

const prepareForwardedEmailReview = Effect.fnUntraced(function* (
  input: CompleteForwardedEmailReviewInput
) {
  const sampleId = input.evidence._tag === "RawSample" ? input.evidence.sampleId : null;
  const money =
    input.evidence._tag === "RawSample"
      ? Option.map(input.evidence.extraction, (value) => value.money)
      : Option.none<Money>();
  const encodedIssues = yield* Schema.encodeEffect(UnknownJsonString)(input.issues).pipe(
    Effect.orDie
  );
  return { encodedIssues, money, sampleId };
});

/** Inserts one visible email NeedsReviewItem and closes the matching receipt atomically. */
export const completeForwardedEmailWithReviewInScope = Effect.fn(
  "completeForwardedEmailWithReviewInScope"
)(function* (input: CompleteForwardedEmailReviewInput) {
  const sql = yield* SqlClient.SqlClient;
  const { encodedIssues, money, sampleId } = yield* prepareForwardedEmailReview(input);
  yield* sql`
    WITH inserted AS (
      INSERT INTO email_needs_review_items (
        id, user_id, received_email_id, ingest_sample_id, reason, known_amount, known_currency,
        service_market, locale, time_zone, source_format, source_channel, source_provider,
        provider_message_id, parser_revision, extractor_revision, issues, status, created_at
      )
      SELECT
        ${input.reviewId}, ${input.context.userId}, ${input.context.receivedEmailId},
        ${sampleId},
        ${input.evidence.reason}, ${Option.getOrNull(Option.map(money, (value) => value.amount))},
        ${Option.getOrNull(Option.map(money, (value) => value.currency))},
        ${input.context.serviceMarket},
        ${input.context.locale}, ${input.context.timeZone}, 'notification-email', 'forwarded-email',
        'resend', ${input.context.receivedEmailId}, ${input.context.parserRevision},
        ${input.extractorRevision}, ${encodedIssues}::jsonb, 'pending', ${input.createdAt}
      FROM forwarded_email_receipts AS receipt
      WHERE receipt.user_id = ${input.context.userId}
        AND receipt.received_email_id = ${input.context.receivedEmailId}
        AND receipt.status = 'accepted'
      ON CONFLICT (received_email_id) DO NOTHING
      RETURNING id
    )
    , completed AS (
      UPDATE forwarded_email_receipts SET status = 'completed',
        review_item_id = inserted.id, completed_at = ${input.createdAt}
      FROM inserted
      WHERE user_id = ${input.context.userId}
        AND received_email_id = ${input.context.receivedEmailId}
        AND status = 'accepted'
      RETURNING forwarded_email_receipts.received_email_id
    )
    DELETE FROM forwarded_email_interpretations
    USING completed
    WHERE user_id = ${input.context.userId}
      AND forwarded_email_interpretations.received_email_id = completed.received_email_id
  `.pipe(Effect.orDie);
});
