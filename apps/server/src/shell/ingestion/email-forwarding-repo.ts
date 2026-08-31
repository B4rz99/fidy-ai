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
} from "~/core/ingestion/model";
import {
  EmailForwardingAddressId,
  EmailForwardingLocalPart,
  ForwardedEmailClaimId,
  IngestSampleId,
  NeedsReviewItemId,
  ResendReceivedEmailId,
  ResendWebhookDeliveryId,
} from "~/core/ingestion/reference";
import { decideEffectiveAccess } from "~/core/identity/rules";
import { UserId } from "~/core/identity/reference";
import {
  type ForwardedEmailClaimInput,
  decideForwardedEmailClaim,
  emailAllowancePeriod,
} from "~/core/ingestion/rules";
import type { TransactionExtraction, TransactionId } from "~/core/transactions/model";
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
  status: Schema.Literals(["queued", "deferred", "processing", "completed", "revoked"]),
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

/** Finds prior provider work before charging allowance for a redelivery. */
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

/** Counts all nonterminal work subject to the durable per-User pressure bound. */
export const countOutstandingEmailsInScope = Effect.fn("countOutstandingEmailsInScope")(function* (
  userId: UserId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: UserId,
    Result: Schema.Struct({ count: Schema.Int }),
    execute: (id) => sql`
        SELECT count(*)::int AS count FROM forwarded_email_receipts
        WHERE user_id = ${id} AND status IN ('queued', 'deferred', 'processing')
      `,
  })(userId).pipe(
    Effect.map((row) => row.count),
    Effect.orDie
  );
});

/** Counts work visibly waiting on the next reset. */
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
    readonly status: "queued" | "deferred";
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
        status: Schema.Literals(["queued", "deferred"]),
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

const ForwardedEmailClaimCandidate = Schema.Struct({
  receivedEmailId: ResendReceivedEmailId,
  userId: UserId,
  status: Schema.Literals(["queued", "deferred", "processing"]),
  resumeAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  startedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  attemptCount: Schema.Int,
  consumed: Schema.Int,
  paidTier: Schema.Literals(["free", "pro"]),
  trialStartedAt: Schema.DateTimeUtcFromDate,
  trialEndsAt: Schema.DateTimeUtcFromDate,
  consumesFreeAllowance: Schema.Boolean,
  periodStart: Schema.DateTimeUtcFromDate,
});

const ClaimedForwardedEmail = Schema.Struct({
  receivedEmailId: ResendReceivedEmailId,
  userId: UserId,
  claimId: ForwardedEmailClaimId,
  ...CapturedInterpretationContext.fields,
  forwardingLocalPart: EmailForwardingLocalPart,
  parserRevision: InterpretationRevision,
  attemptCount: Schema.Int,
});
/** Fenced durable claim returned only to the ingestion processor facet. */
export type ClaimedForwardedEmail = typeof ClaimedForwardedEmail.Type;

type ClaimCandidate = typeof ForwardedEmailClaimCandidate.Type;

type AllowancePeriod = Readonly<{
  from: DateTime.Utc;
  toExclusive: DateTime.Utc;
}>;

const claimInputFromCandidate = (
  candidate: ClaimCandidate,
  access: "free" | "pro",
  now: DateTime.Utc
): ForwardedEmailClaimInput => {
  const claimContext = {
    access,
    attemptCount: candidate.attemptCount,
    consumed: candidate.consumed,
    now,
  } as const;
  switch (candidate.status) {
    case "queued":
      return { ...claimContext, status: "queued" };
    case "deferred":
      return {
        ...claimContext,
        status: "deferred",
        resumeAt: Option.getOrThrow(candidate.resumeAt),
      };
    case "processing":
      return {
        ...claimContext,
        status: "processing",
        startedAt: Option.getOrThrow(candidate.startedAt),
      };
  }
};

const claimCandidate = Effect.fn(function* (
  candidate: ClaimCandidate,
  now: DateTime.Utc,
  period: AllowancePeriod
) {
  const sql = yield* SqlClient.SqlClient;
  const access = yield* decideEffectiveAccess(
    {
      paidTier: candidate.paidTier,
      trialPeriod: { startedAt: candidate.trialStartedAt, endsAt: candidate.trialEndsAt },
    },
    now
  );
  const decision = decideForwardedEmailClaim(claimInputFromCandidate(candidate, access, now));
  if (decision._tag === "Skip") return Option.none<ClaimedForwardedEmail>();
  if (decision._tag === "Exhausted") {
    yield* sql`
      SELECT fidy_exhaust_stale_forwarded_email(
        ${candidate.receivedEmailId}, ${now}, ${decision.staleBefore}
      )
    `.pipe(Effect.orDie);
    return Option.none<ClaimedForwardedEmail>();
  }
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({
      receivedEmailId: ResendReceivedEmailId,
      promoted: Schema.Boolean,
      periodStart: Schema.DateTimeUtc,
      consumesFreeAllowance: Schema.Boolean,
    }),
    Result: ClaimedForwardedEmail,
    execute: (input) => sql`
      SELECT received_email_id AS "receivedEmailId", user_id AS "userId",
        claim_id AS "claimId", service_market AS "serviceMarket", locale,
        time_zone AS "timeZone", forwarding_local_part AS "forwardingLocalPart",
        parser_revision AS "parserRevision", attempt_count AS "attemptCount"
      FROM fidy_claim_forwarded_email(
        ${input.receivedEmailId}, ${input.promoted}, ${input.periodStart},
        ${input.consumesFreeAllowance}
      )
    `,
  })({
    receivedEmailId: candidate.receivedEmailId,
    promoted: decision.promotedFromDeferred,
    periodStart: decision.promotedFromDeferred ? period.from : candidate.periodStart,
    consumesFreeAllowance: decision.promotedFromDeferred
      ? decision.consumesFreeAllowance
      : candidate.consumesFreeAllowance,
  }).pipe(Effect.orDie);
});

/** Claims at most one queued, due-deferred, or stale email through the narrow gateway. */
export const claimForwardedEmail = Effect.fn("claimForwardedEmail")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const period = emailAllowancePeriod(now);
        const candidates = yield* SqlSchema.findAll({
          Request: Schema.Struct({ from: Schema.DateTimeUtc, to: Schema.DateTimeUtc }),
          Result: ForwardedEmailClaimCandidate,
          execute: (input) => sql`
            SELECT received_email_id AS "receivedEmailId", user_id AS "userId", status,
              resume_at AS "resumeAt", started_at AS "startedAt", attempt_count AS "attemptCount",
              consumed, paid_tier AS "paidTier", trial_started_at AS "trialStartedAt",
              trial_ends_at AS "trialEndsAt", consumes_free_allowance AS "consumesFreeAllowance",
              period_start AS "periodStart"
            FROM fidy_forwarded_email_claim_candidates(${input.from}, ${input.to})
          `,
        })({ from: period.from, to: period.toExclusive }).pipe(Effect.orDie);
        for (const candidate of candidates) {
          const claimed = yield* claimCandidate(candidate, now, period);
          if (Option.isSome(claimed)) return claimed;
        }
        return Option.none<ClaimedForwardedEmail>();
      })
    )
    .pipe(Effect.orDie);
});

/** Requeues one claim after core policy selected its bounded retry transition. */
export const retryForwardedEmailClaim = Effect.fn("retryForwardedEmailClaim")(function* (
  claimed: ClaimedForwardedEmail
) {
  const sql = yield* SqlClient.SqlClient;
  yield* withUserTransaction(
    claimed.userId,
    sql`
      UPDATE forwarded_email_receipts
      SET status = 'queued', claim_id = NULL
      WHERE user_id = ${claimed.userId} AND received_email_id = ${claimed.receivedEmailId}
        AND claim_id = ${claimed.claimId}
    `.pipe(Effect.orDie)
  );
});

/** Defers a claimed email without provider egress while the User lacks current Consent. */
export const deferForwardedEmailClaimForConsent = Effect.fn("deferForwardedEmailClaimForConsent")(
  function* (claimed: ClaimedForwardedEmail, resumeAt: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    yield* withUserTransaction(
      claimed.userId,
      sql`
      UPDATE forwarded_email_receipts
      SET status = 'deferred', claim_id = NULL, started_at = NULL, resume_at = ${resumeAt}
      WHERE user_id = ${claimed.userId} AND received_email_id = ${claimed.receivedEmailId}
        AND claim_id = ${claimed.claimId}
    `.pipe(Effect.orDie)
    );
  }
);

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

/** Verifies claim ownership before the worker creates any final outcome. */
export const ownsForwardedEmailClaimInScope = Effect.fn("ownsForwardedEmailClaimInScope")(
  function* (claimed: ClaimedForwardedEmail) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: Schema.Struct({
        userId: UserId,
        receivedEmailId: ResendReceivedEmailId,
        claimId: ForwardedEmailClaimId,
      }),
      Result: Schema.Struct({ owned: Schema.Boolean }),
      execute: (row) => sql`
      SELECT true AS owned FROM forwarded_email_receipts
      WHERE user_id = ${row.userId} AND received_email_id = ${row.receivedEmailId}
        AND status = 'processing' AND claim_id = ${row.claimId}
      FOR UPDATE
    `,
    })(claimed).pipe(Effect.map(Option.isSome), Effect.orDie);
  }
);

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
  claimed: ClaimedForwardedEmail,
  transactionId: TransactionId,
  completedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE forwarded_email_receipts SET status = 'completed', claim_id = NULL,
      transaction_id = ${transactionId}, completed_at = ${completedAt}
    WHERE user_id = ${claimed.userId} AND received_email_id = ${claimed.receivedEmailId}
      AND claim_id = ${claimed.claimId}
  `.pipe(Effect.orDie);
});

/** Inserts one visible email NeedsReviewItem and closes the matching claim atomically. */
export const completeForwardedEmailWithReviewInScope = Effect.fn(
  "completeForwardedEmailWithReviewInScope"
)(function* (input: {
  readonly claimed: ClaimedForwardedEmail;
  readonly reviewId: NeedsReviewItemId;
  readonly evidence:
    | Readonly<{
        readonly _tag: "ProviderMessage";
        readonly reason: "provider-retrieval-failed";
      }>
    | Readonly<{
        readonly _tag: "RawSample";
        readonly sampleId: IngestSampleId;
        readonly reason: "model-unavailable" | "canonical-validation-failed";
        readonly extraction: Option.Option<TransactionExtraction>;
      }>;
  readonly extractorRevision: string;
  readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  readonly createdAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  const sampleId = input.evidence._tag === "RawSample" ? input.evidence.sampleId : null;
  const money =
    input.evidence._tag === "RawSample"
      ? Option.map(input.evidence.extraction, (value) => value.money)
      : Option.none<Money>();
  const encodedIssues = yield* Schema.encodeEffect(UnknownJsonString)(input.issues).pipe(
    Effect.orDie
  );
  yield* sql`
    WITH inserted AS (
      INSERT INTO email_needs_review_items (
        id, user_id, received_email_id, ingest_sample_id, reason, known_amount, known_currency,
        service_market, locale, time_zone, source_format, source_channel, source_provider,
        provider_message_id, parser_revision, extractor_revision, issues, status, created_at
      )
      SELECT
        ${input.reviewId}, ${input.claimed.userId}, ${input.claimed.receivedEmailId},
        ${sampleId},
        ${input.evidence.reason}, ${Option.getOrNull(Option.map(money, (value) => value.amount))},
        ${Option.getOrNull(Option.map(money, (value) => value.currency))},
        ${input.claimed.serviceMarket},
        ${input.claimed.locale}, ${input.claimed.timeZone}, 'notification-email', 'forwarded-email',
        'resend', ${input.claimed.receivedEmailId}, ${input.claimed.parserRevision},
        ${input.extractorRevision}, ${encodedIssues}::jsonb, 'pending', ${input.createdAt}
      FROM forwarded_email_receipts AS receipt
      WHERE receipt.user_id = ${input.claimed.userId}
        AND receipt.received_email_id = ${input.claimed.receivedEmailId}
        AND receipt.status = 'processing' AND receipt.claim_id = ${input.claimed.claimId}
      ON CONFLICT (received_email_id) DO NOTHING
      RETURNING id
    )
    UPDATE forwarded_email_receipts SET status = 'completed', claim_id = NULL,
      review_item_id = inserted.id, completed_at = ${input.createdAt}
    FROM inserted
    WHERE user_id = ${input.claimed.userId} AND received_email_id = ${input.claimed.receivedEmailId}
      AND claim_id = ${input.claimed.claimId}
  `.pipe(Effect.orDie);
});
