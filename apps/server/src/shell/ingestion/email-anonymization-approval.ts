import { Context, Crypto, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import { AnonymizedEmailIngestSample } from "~/core/ingestion/model";
import { IngestSampleId } from "~/core/ingestion/reference";
import { MigrationSqlClient } from "~/shell/db/client";

const maximumApprovedOperatorIdCharacters = 120;

/** Auditable identifier of the human operator approving a User-unlinked sample. */
export const ApprovedOperatorId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumApprovedOperatorIdCharacters)
).pipe(Schema.brand("ApprovedOperatorId"));
/** Branded operator identifier accepted by the privileged approval seam. */
export type ApprovedOperatorId = typeof ApprovedOperatorId.Type;

const ApprovalCandidate = Schema.Struct({
  id: IngestSampleId,
  serviceMarket: AnonymizedEmailIngestSample.fields.serviceMarket,
  parserRevision: InterpretationRevision,
  anonymizationRevision: InterpretationRevision,
  structure: AnonymizedEmailIngestSample.fields.structure,
  retainedAt: Schema.DateTimeUtcFromDate,
});

/**
 * Privileged operator seam: an automatic candidate remains personal, expiring data until this
 * explicit approval copies only its reviewed structure into the User-unlinked indefinite IngestSample collection.
 */
const approveAnonymizedEmailSample = Effect.fn("approveAnonymizedEmailSample")(function* (input: {
  readonly sampleId: IngestSampleId;
  readonly approvedBy: ApprovedOperatorId;
}) {
  const crypto = yield* Crypto.Crypto;
  const sql = yield* MigrationSqlClient;
  const approvedAt = yield* DateTime.now;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const candidate = yield* SqlSchema.findOneOption({
        Request: Schema.Struct({ id: IngestSampleId, approvedAt: Schema.DateTimeUtc }),
        Result: ApprovalCandidate,
        execute: (request) => sql`
            SELECT id, service_market AS "serviceMarket", parser_revision AS "parserRevision",
              anonymization_revision AS "anonymizationRevision",
              anonymization_candidate AS structure, retained_at AS "retainedAt"
            FROM raw_email_ingest_samples
            WHERE id = ${request.id} AND expires_at > ${request.approvedAt}
            FOR UPDATE
          `,
      })({ id: input.sampleId, approvedAt });
      if (Option.isNone(candidate)) return false;
      yield* sql`
          INSERT INTO anonymized_email_ingest_samples (
            id, service_market, source_format, source_provider, parser_revision,
            anonymization_revision, structure, approved_by, approved_at, retained_at
          ) VALUES (
            ${IngestSampleId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie))}, ${candidate.value.serviceMarket}, 'notification-email', 'resend',
            ${candidate.value.parserRevision}, ${candidate.value.anonymizationRevision},
            ${candidate.value.structure}, ${input.approvedBy}, ${approvedAt},
            ${candidate.value.retainedAt}
          ) ON CONFLICT (id) DO NOTHING
        `;
      return true;
    }).pipe(Effect.orDie)
  );
});

const makeForwardedEmailSampleApproval = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sql = yield* MigrationSqlClient;
  return {
    approve: (input: {
      readonly sampleId: IngestSampleId;
      readonly approvedBy: ApprovedOperatorId;
    }) =>
      approveAnonymizedEmailSample(input).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(MigrationSqlClient, sql)
      ),
  } as const;
});

/** Privileged facet unavailable from the ordinary server runtime. */
export class ForwardedEmailSampleApproval extends Context.Service<
  ForwardedEmailSampleApproval,
  Effect.Success<typeof makeForwardedEmailSampleApproval>
>()("@fidy/server/shell/ingestion/email-anonymization-approval/ForwardedEmailSampleApproval") {
  static readonly layer = Layer.effect(
    ForwardedEmailSampleApproval,
    makeForwardedEmailSampleApproval
  );
}
