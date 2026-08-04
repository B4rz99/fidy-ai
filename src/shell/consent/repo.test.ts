import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Exit, Option } from "effect";
import {
  ConsentRecord,
  ConsentRecordId,
  DisclosureRevision,
  DisclosureSnapshot,
  PendingConsentExchangeId,
} from "~/core/consent/model";
import { E164PhoneNumber, UserId } from "~/core/identity/reference";
import { makeColombianUser } from "~/core/identity/rules";
import { MigrationSqlClient } from "~/shell/db/client";
import { defaultAgentTokenId, defaultUserId } from "~/shell/db/development-seed";
import { insertUser } from "~/shell/identity/repo";
import { ApiHarness } from "~/shell/testing/api-harness";
import { currentDisclosure } from "./current-disclosure";
import {
  appendConsentRecord,
  claimConsentDisclosureDelivery,
  findConsentRecordByDecisionMessage,
  findPendingConsentExchange,
  hasCurrentOnboardingConsent,
  insertPendingConsentExchange,
  recordConsentDisclosureDelivery,
  observeConsentRecords,
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
const createdAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");
const otherUserId = UserId.make("f1d1a000-0000-4000-8000-0000000008d1");

const clearConsent = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM pending_consent_exchanges WHERE phone_number = ${phoneNumber}`;
  yield* sql`DELETE FROM consent_records WHERE subject_user_id = ${defaultUserId}`;
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "consent persistence",
  (it) => {
    it.effect("moves the pending lifecycle forward and deletes it explicitly", () =>
      Effect.gen(function* () {
        yield* clearConsent;
        const disclosure = yield* currentDisclosure;
        const pending = {
          _tag: "AwaitingDisclosureDelivery",
          id: PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000821"),
          phoneNumber,
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
        expect(yield* findPendingConsentExchange(phoneNumber)).toEqual(Option.some(pending));

        const deliveredAt = DateTime.makeUnsafe("2026-08-01T12:00:01Z");
        const claim = yield* claimConsentDisclosureDelivery(pending.id, deliveredAt);
        expect(Option.isSome(claim)).toBe(true);
        if (Option.isNone(claim)) return yield* Effect.die("missing disclosure claim");
        expect(Option.isNone(yield* claimConsentDisclosureDelivery(pending.id, deliveredAt))).toBe(
          true
        );
        const awaitingDecision = yield* recordConsentDisclosureDelivery({
          exchangeId: pending.id,
          claimId: claim.value.claimId,
          message: disclosureMessage,
          deliveredAt,
        });
        expect(Option.isSome(awaitingDecision)).toBe(true);
        if (Option.isNone(awaitingDecision)) return yield* Effect.die("missing pending exchange");
        expect(awaitingDecision.value.disclosureMessage).toEqual(disclosureMessage);

        expect(
          yield* recordConsentDisclosureDelivery({
            exchangeId: pending.id,
            claimId: claim.value.claimId,
            message: { ...disclosureMessage, providerMessageId: "wamid.conflicting-delivery" },
            deliveredAt: DateTime.makeUnsafe("2026-08-01T12:00:02Z"),
          })
        ).toEqual(Option.none());
        expect(yield* findPendingConsentExchange(phoneNumber)).toEqual(awaitingDecision);
        expect(
          yield* recordConsentDisclosureDelivery({
            exchangeId: PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000822"),
            claimId: claim.value.claimId,
            message: disclosureMessage,
            deliveredAt: DateTime.makeUnsafe("2026-08-01T12:00:01Z"),
          })
        ).toEqual(Option.none());

        yield* removePendingConsentExchange(pending.id);
        expect(Option.isNone(yield* findPendingConsentExchange(phoneNumber))).toBe(true);
      })
    );

    it.effect("rejects referenced grants owned by another subject", () =>
      Effect.gen(function* () {
        yield* clearConsent;
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM consent_records WHERE subject_user_id = ${otherUserId}`;
        yield* sql`DELETE FROM users WHERE id = ${otherUserId}`;
        const otherUser = yield* makeColombianUser(otherUserId, { createdAt });
        yield* insertUser(otherUserId, otherUser);
        const disclosure = yield* currentDisclosure;

        const grant = ConsentRecord.make({
          id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000835"),
          subjectUserId: defaultUserId,
          event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
          disclosure,
          occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:02Z"),
          disclosureMessage,
          decisionMessage: {
            ...decisionMessage,
            providerMessageId: "wamid.repo-owner-grant",
          },
        });
        yield* appendConsentRecord(grant);

        const crossUserRevocation = ConsentRecord.make({
          ...grant,
          id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000836"),
          subjectUserId: otherUserId,
          event: { _tag: "Revoked", grantId: grant.id },
          occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:03Z"),
          decisionMessage: {
            ...decisionMessage,
            providerMessageId: "wamid.repo-cross-user-revocation",
          },
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
            grant: { _tag: "AgentToken", tokenId: defaultAgentTokenId },
          },
          occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:04Z"),
          decisionMessage: {
            ...decisionMessage,
            providerMessageId: "wamid.repo-cross-user-agent-token",
          },
        });
        expect(Exit.isFailure(yield* Effect.exit(appendConsentRecord(crossUserTokenGrant)))).toBe(
          true
        );
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const sql = yield* MigrationSqlClient;
            yield* sql`DELETE FROM consent_records WHERE subject_user_id = ${otherUserId}`;
            yield* sql`DELETE FROM consent_records WHERE subject_user_id = ${defaultUserId}`;
            yield* sql`DELETE FROM users WHERE id = ${otherUserId}`;
          }).pipe(Effect.orDie)
        )
      )
    );

    it.effect("does not treat a historical disclosure revision as current consent", () =>
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
            disclosureMessage,
            decisionMessage: {
              ...decisionMessage,
              providerMessageId: "wamid.repo-stale-decision",
            },
          })
        );

        expect(yield* hasCurrentOnboardingConsent(defaultUserId)).toBe(false);
      })
    );

    it.effect("appends grants and revocations without mutating the original evidence", () =>
      Effect.gen(function* () {
        yield* clearConsent;
        const disclosure = yield* currentDisclosure;
        const grant = ConsentRecord.make({
          id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000831"),
          subjectUserId: defaultUserId,
          event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
          disclosure,
          occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:02Z"),
          disclosureMessage,
          decisionMessage,
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
          decisionMessage: {
            ...decisionMessage,
            providerMessageId: "wamid.repo-revocation",
          },
        });
        yield* appendConsentRecord(revocation);

        const agentTokenGrant = ConsentRecord.make({
          ...grant,
          id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000833"),
          event: {
            _tag: "Granted",
            grant: { _tag: "AgentToken", tokenId: defaultAgentTokenId },
          },
          occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:04Z"),
          decisionMessage: {
            ...decisionMessage,
            providerMessageId: "wamid.repo-agent-token",
          },
        });
        yield* appendConsentRecord(agentTokenGrant);

        const insightDeliveryGrant = ConsentRecord.make({
          ...grant,
          id: ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000834"),
          event: {
            _tag: "Granted",
            grant: { _tag: "InsightDelivery", insightKind: "weekly-summary" },
          },
          occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:05Z"),
          decisionMessage: {
            ...decisionMessage,
            providerMessageId: "wamid.repo-insight-delivery",
          },
        });
        yield* appendConsentRecord(insightDeliveryGrant);

        expect(yield* hasCurrentOnboardingConsent(defaultUserId)).toBe(false);
        expect(yield* observeConsentRecords(defaultUserId)).toEqual([
          grant,
          revocation,
          agentTokenGrant,
          insightDeliveryGrant,
        ]);
      })
    );
  }
);
