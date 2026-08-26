import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Exit, Option } from "effect";
import {
  type ConsentDecisionEvidence,
  ConsentRecord,
  ConsentRecordId,
  DisclosureRevision,
  DisclosureSnapshot,
  PendingConsentExchangeId,
} from "~/core/consent/model";
import { EmailEnrollmentId, EmailVerificationPublicCode } from "~/core/email-authentication/model";
import { E164PhoneNumber, UserId, whatsAppCallerReference } from "~/core/identity/reference";
import { makeColombianUser } from "~/core/identity/rules";
import { MigrationSqlClient } from "~/shell/db/client";
import { defaultPATId, defaultUserId, seedOnboardingConsent } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import { upsertStableUserFixture } from "~/shell/testing/identity-fixtures";
import { deliverConsentDisclosureForTesting } from "~/shell/testing/consent-disclosure";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import { currentDisclosure } from "./current-disclosure";
import {
  appendConsentRecord,
  findConsentRecordByDecisionMessage,
  findPendingConsentExchange,
  hasCurrentOnboardingConsent,
  insertPendingConsentExchange,
  observeConsentRecords,
  recordConsentDisclosureDelivery,
  removeExpiredPendingConsentExchanges,
  removePendingConsentExchange,
} from "./repo";

const phoneNumber = E164PhoneNumber.make("+573009998877");
const disclosureMessage = {
  channel: "whatsapp",
  provider: "kapso",
  providerMessageId: "wamid.repo-disclosure",
} as const;
const decisionMessage = {
  channel: "whatsapp",
  provider: "kapso",
  providerMessageId: "wamid.repo-decision",
} as const;
const providerEvidence = (
  decision: Readonly<{
    channel: string;
    provider: string;
    providerMessageId: string;
  }> = decisionMessage
): ConsentDecisionEvidence => ({
  _tag: "ProviderQualifiedMessages" as const,
  disclosureMessage,
  decisionMessage: decision,
});
const createdAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");
const otherUserId = UserId.make("f1d1a000-0000-4000-8000-0000000008d1");

const clearConsent = Effect.gen(function* () {
  yield* seedOnboardingConsent(defaultUserId);
  const records = yield* observeConsentRecords(defaultUserId);
  const grant = records.findLast(
    (record) => record.event._tag === "Granted" && record.event.grant._tag === "Onboarding"
  );
  if (grant === undefined) return yield* Effect.die("missing fixture Consent grant");
  const sql = yield* MigrationSqlClient;
  const caller = testWhatsAppCaller(phoneNumber);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM email_enrollments
        WHERE business_portfolio_id = ${caller.businessPortfolioId}
          AND business_scoped_user_id = ${caller.businessScopedUserId}`;
      yield* sql`DELETE FROM pending_consent_exchanges
        WHERE business_portfolio_id = ${caller.businessPortfolioId}
          AND business_scoped_user_id = ${caller.businessScopedUserId}`;
      yield* sql`DELETE FROM hosted_agent_sessions WHERE user_id = ${defaultUserId}`;
      yield* sql`DELETE FROM consent_records
        WHERE subject_user_id = ${defaultUserId} AND event_type = 'revoked'`;
      yield* sql`DELETE FROM consent_records
        WHERE subject_user_id = ${defaultUserId} AND id <> ${grant.id}`;
      yield* sql`
        INSERT INTO consent_records (
          id, subject_user_id, event_type, grant_type, pat_id, insight_kind,
          revoked_grant_id, service_market, locale, disclosure_revision,
          disclosure_sha256, disclosure_text, policy_url, policy_revision,
          policy_sha256, purposes, data_categories, duration, revocation_method,
          decision_origin, disclosure_channel, disclosure_provider, disclosure_provider_message_id,
          decision_channel, decision_provider, decision_provider_message_id, occurred_at
        ) SELECT
          ${ConsentRecordId.make("f1d1a000-0000-4000-8000-00000000082f")}, subject_user_id,
          'revoked', NULL, NULL, NULL, id, service_market, locale, disclosure_revision,
          disclosure_sha256, disclosure_text, policy_url, policy_revision,
          policy_sha256, purposes, data_categories, duration, revocation_method,
          decision_origin, disclosure_channel, disclosure_provider, disclosure_provider_message_id,
          'development', 'development-seed', 'development-seed:consent-test-reset',
          occurred_at + interval '1 millisecond'
        FROM consent_records WHERE id = ${grant.id}
      `;
    })
  );
});

// Every case rewrites the seeded User's Consent evidence, so the seeded onboarding basis is
// restored afterwards; otherwise later test files observe a revoked User.
const restoreSeededConsent = Effect.gen(function* () {
  yield* seedOnboardingConsent(defaultUserId);
  const records = yield* observeConsentRecords(defaultUserId);
  const grant = records.findLast(
    (record) =>
      record.event._tag === "Granted" &&
      record.evidence._tag === "ProviderQualifiedMessages" &&
      record.evidence.disclosureMessage.provider === "development-seed"
  );
  if (grant === undefined) return yield* Effect.die("missing development Consent grant");
  const sql = yield* MigrationSqlClient;
  const caller = testWhatsAppCaller(phoneNumber);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM email_enrollments
        WHERE business_portfolio_id = ${caller.businessPortfolioId}
          AND business_scoped_user_id = ${caller.businessScopedUserId}`;
      yield* sql`DELETE FROM pending_consent_exchanges
        WHERE business_portfolio_id = ${caller.businessPortfolioId}
          AND business_scoped_user_id = ${caller.businessScopedUserId}`;
      yield* sql`DELETE FROM hosted_agent_sessions WHERE user_id = ${defaultUserId}`;
      yield* sql`DELETE FROM consent_records
        WHERE subject_user_id = ${defaultUserId} AND event_type = 'revoked'`;
      yield* sql`DELETE FROM consent_records
        WHERE subject_user_id = ${defaultUserId} AND id <> ${grant.id}`;
    })
  );
}).pipe(Effect.orDie);

const withinFixtureTransaction = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => effect;

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "consent persistence",
  (it) => {
    it.effect("moves the pending lifecycle forward and deletes it explicitly", () =>
      withinFixtureTransaction(
        Effect.gen(function* () {
          yield* clearConsent;
          const disclosure = yield* currentDisclosure;
          const pending = {
            _tag: "AwaitingDisclosureDelivery",
            id: PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000821"),
            caller: whatsAppCallerReference(testWhatsAppCaller(phoneNumber)),
            disclosure,
            initiatingMessage: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: "wamid.repo-initiator",
            },
            createdAt,
            expiresAt: DateTime.makeUnsafe("2026-08-02T12:00:00Z"),
          } as const;

          yield* insertPendingConsentExchange(pending);
          expect(yield* findPendingConsentExchange(testWhatsAppCaller(phoneNumber))).toEqual(
            Option.some(pending)
          );

          const deliveredAt = DateTime.makeUnsafe("2026-08-01T12:00:01Z");
          const delivered = yield* deliverConsentDisclosureForTesting({
            exchangeId: pending.id,
            message: disclosureMessage,
            deliveredAt,
          });
          expect(delivered.result).toBe("applied");
          const awaitingDecision = yield* findPendingConsentExchange(
            testWhatsAppCaller(phoneNumber)
          );
          expect(Option.isSome(awaitingDecision)).toBe(true);
          if (Option.isNone(awaitingDecision)) return yield* Effect.die("missing pending exchange");
          if (awaitingDecision.value._tag !== "AwaitingDecision") {
            return yield* Effect.die("delivery did not advance pending Consent");
          }
          expect(awaitingDecision.value.disclosureMessage).toEqual(disclosureMessage);

          expect(
            yield* recordConsentDisclosureDelivery({
              exchangeId: pending.id,
              correlationToken: delivered.correlationToken,
              message: { ...disclosureMessage, providerMessageId: "wamid.conflicting-delivery" },
              deliveredAt: DateTime.makeUnsafe("2026-08-01T12:00:02Z"),
            })
          ).toEqual(Option.none());
          expect(yield* findPendingConsentExchange(testWhatsAppCaller(phoneNumber))).toEqual(
            awaitingDecision
          );
          expect(
            yield* recordConsentDisclosureDelivery({
              exchangeId: PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000822"),
              correlationToken: delivered.correlationToken,
              message: disclosureMessage,
              deliveredAt: DateTime.makeUnsafe("2026-08-01T12:00:01Z"),
            })
          ).toEqual(Option.none());

          yield* removePendingConsentExchange(pending.id);
          expect(
            Option.isNone(yield* findPendingConsentExchange(testWhatsAppCaller(phoneNumber)))
          ).toBe(true);
        }).pipe(Effect.ensuring(restoreSeededConsent))
      )
    );

    it.effect("retains accepted evidence for the enrollment's full 24 hours", () =>
      withinFixtureTransaction(
        Effect.gen(function* () {
          yield* clearConsent;
          const caller = testWhatsAppCaller(phoneNumber);
          const disclosure = yield* currentDisclosure;
          const exchangeId = PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000823");
          const acceptedAt = DateTime.makeUnsafe("2026-08-02T11:00:00Z");
          const enrollmentExpiresAt = DateTime.makeUnsafe("2026-08-03T11:00:00Z");
          yield* insertPendingConsentExchange({
            _tag: "AwaitingDisclosureDelivery",
            id: exchangeId,
            caller: whatsAppCallerReference(caller),
            disclosure,
            initiatingMessage: {
              channel: "whatsapp",
              provider: "kapso",
              providerMessageId: "wamid.repo-retention-initiator",
            },
            createdAt,
            expiresAt: DateTime.makeUnsafe("2026-08-02T12:00:00Z"),
          });
          const sql = yield* MigrationSqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE pending_consent_exchanges SET
                  decision_channel = 'whatsapp', decision_provider = 'kapso',
                  decision_provider_message_id = 'wamid.repo-retention-decision',
                  accepted_at = ${acceptedAt}
                WHERE id = ${exchangeId}
              `;
              yield* sql`
                INSERT INTO email_enrollments (
                  id, public_code, business_portfolio_id, business_scoped_user_id,
                  parent_business_scoped_user_id, username, phone_number,
                  pending_consent_exchange_id, expires_at
                ) VALUES (
                  ${EmailEnrollmentId.make("f1d1a000-0000-4000-8000-000000000824")},
                  ${EmailVerificationPublicCode.make("ABCD-EFGH")}, ${caller.businessPortfolioId},
                  ${caller.businessScopedUserId}, ${Option.getOrNull(caller.parentBusinessScopedUserId)},
                  ${Option.getOrNull(caller.username)}, ${Option.getOrNull(caller.phoneNumber)},
                  ${exchangeId}, ${enrollmentExpiresAt}
                )
              `;
            })
          );

          yield* removeExpiredPendingConsentExchanges(DateTime.makeUnsafe("2026-08-02T12:00:00Z"));
          expect(
            yield* sql`SELECT id FROM email_enrollments WHERE id = ${"f1d1a000-0000-4000-8000-000000000824"}`
          ).toHaveLength(1);
          expect(
            yield* sql`SELECT id FROM pending_consent_exchanges WHERE id = ${exchangeId}`
          ).toHaveLength(1);

          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM email_enrollments
                WHERE pending_consent_exchange_id = ${exchangeId}`;
              yield* sql`DELETE FROM pending_consent_exchanges WHERE id = ${exchangeId}`;
            })
          );
          expect(
            yield* sql`SELECT id FROM email_enrollments WHERE pending_consent_exchange_id = ${exchangeId}`
          ).toHaveLength(0);
          expect(
            yield* sql`SELECT id FROM pending_consent_exchanges WHERE id = ${exchangeId}`
          ).toHaveLength(0);
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const sql = yield* MigrationSqlClient;
              yield* sql`DELETE FROM email_enrollments WHERE pending_consent_exchange_id = ${PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000823")}`;
              yield* sql`DELETE FROM pending_consent_exchanges WHERE id = ${PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000823")}`;
            }).pipe(Effect.orDie)
          ),
          Effect.ensuring(restoreSeededConsent)
        )
      )
    );

    it.effect("rejects referenced grants owned by another subject", () =>
      withinFixtureTransaction(
        Effect.gen(function* () {
          yield* clearConsent;
          const sql = yield* MigrationSqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM consent_records WHERE subject_user_id = ${otherUserId}`;
              yield* sql`DELETE FROM users WHERE id = ${otherUserId}`;
            })
          );
          const otherUser = yield* makeColombianUser(otherUserId, { createdAt, paidTier: "free" });
          yield* upsertStableUserFixture(otherUserId, otherUser);
          const disclosure = yield* currentDisclosure;

          const grant = ConsentRecord.make({
            id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000835"),
            subjectUserId: defaultUserId,
            event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
            disclosure,
            occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:02Z"),
            evidence: providerEvidence({
              ...decisionMessage,
              providerMessageId: "wamid.repo-owner-grant",
            }),
          });
          yield* appendConsentRecord(grant);

          const crossUserRevocation = ConsentRecord.make({
            ...grant,
            id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000836"),
            subjectUserId: otherUserId,
            event: { _tag: "Revoked", grantId: grant.id },
            occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:03Z"),
            evidence: providerEvidence({
              ...decisionMessage,
              providerMessageId: "wamid.repo-cross-user-revocation",
            }),
          });

          expect(Exit.isFailure(yield* Effect.exit(appendConsentRecord(crossUserRevocation)))).toBe(
            true
          );
          expect(yield* hasCurrentOnboardingConsent(defaultUserId)).toBe(true);

          const crossUserTokenGrant = ConsentRecord.make({
            ...grant,
            id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000837"),
            subjectUserId: otherUserId,
            event: {
              _tag: "Granted",
              grant: { _tag: "PAT", tokenId: defaultPATId },
            },
            occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:04Z"),
            evidence: providerEvidence({
              ...decisionMessage,
              providerMessageId: "wamid.repo-cross-user-pat",
            }),
          });
          expect(Exit.isFailure(yield* Effect.exit(appendConsentRecord(crossUserTokenGrant)))).toBe(
            true
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const sql = yield* MigrationSqlClient;
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`DELETE FROM hosted_agent_sessions
                    WHERE user_id IN (${otherUserId}, ${defaultUserId})`;
                  yield* sql`DELETE FROM consent_records WHERE subject_user_id = ${otherUserId}`;
                  yield* sql`DELETE FROM users WHERE id = ${otherUserId}`;
                })
              );
            }).pipe(Effect.orDie)
          ),
          Effect.ensuring(restoreSeededConsent)
        )
      )
    );

    it.effect("does not treat a historical disclosure revision as current consent", () =>
      withinFixtureTransaction(
        Effect.gen(function* () {
          yield* clearConsent;
          const current = yield* currentDisclosure;
          const stale = DisclosureSnapshot.make({
            ...current,
            revision: DisclosureRevision.make("onboarding-2025-legacy"),
          });
          yield* appendConsentRecord(
            ConsentRecord.make({
              id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000839"),
              subjectUserId: defaultUserId,
              event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
              disclosure: stale,
              occurredAt: createdAt,
              evidence: providerEvidence({
                ...decisionMessage,
                providerMessageId: "wamid.repo-stale-decision",
              }),
            })
          );

          expect(yield* hasCurrentOnboardingConsent(defaultUserId)).toBe(false);
        }).pipe(Effect.ensuring(restoreSeededConsent))
      )
    );

    it.effect("appends grants and revocations without mutating the original evidence", () =>
      withinFixtureTransaction(
        Effect.gen(function* () {
          yield* clearConsent;
          const disclosure = yield* currentDisclosure;
          const grant = ConsentRecord.make({
            id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000831"),
            subjectUserId: defaultUserId,
            event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
            disclosure,
            occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:02Z"),
            evidence: providerEvidence(),
          });

          yield* appendConsentRecord(grant);
          expect(yield* hasCurrentOnboardingConsent(defaultUserId)).toBe(true);
          expect(yield* findConsentRecordByDecisionMessage(decisionMessage)).toEqual(
            Option.some(grant)
          );

          const revocation = ConsentRecord.make({
            ...grant,
            id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000832"),
            event: { _tag: "Revoked", grantId: grant.id },
            occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:03Z"),
            evidence: providerEvidence({
              ...decisionMessage,
              providerMessageId: "wamid.repo-revocation",
            }),
          });
          yield* appendConsentRecord(revocation);

          const patGrant = ConsentRecord.make({
            ...grant,
            id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000833"),
            event: {
              _tag: "Granted",
              grant: { _tag: "PAT", tokenId: defaultPATId },
            },
            occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:04Z"),
            evidence: providerEvidence({
              ...decisionMessage,
              providerMessageId: "wamid.repo-pat",
            }),
          });
          yield* appendConsentRecord(patGrant);

          const insightDeliveryGrant = ConsentRecord.make({
            ...grant,
            id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000834"),
            event: {
              _tag: "Granted",
              grant: { _tag: "InsightDelivery", insightKind: "weekly-summary" },
            },
            occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:05Z"),
            evidence: providerEvidence({
              ...decisionMessage,
              providerMessageId: "wamid.repo-insight-delivery",
            }),
          });
          yield* appendConsentRecord(insightDeliveryGrant);

          expect(yield* hasCurrentOnboardingConsent(defaultUserId)).toBe(false);
          const observed = yield* observeConsentRecords(defaultUserId);
          const assertedIds = new Set([
            grant.id,
            revocation.id,
            patGrant.id,
            insightDeliveryGrant.id,
          ]);
          expect(observed.filter((record) => assertedIds.has(record.id))).toEqual([
            grant,
            revocation,
            patGrant,
            insightDeliveryGrant,
          ]);
        }).pipe(Effect.ensuring(restoreSeededConsent))
      )
    );
  }
);
