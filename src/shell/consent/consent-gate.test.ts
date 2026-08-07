import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Exit, Option, Schema } from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/unstable/sql";
import type { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import {
  ConsentRecord,
  ConsentRecordId,
  type PendingConsentExchangeId,
} from "~/core/consent/model";
import { E164PhoneNumber, UserId } from "~/core/identity/reference";
import { WhatsAppCaller } from "~/shell/channels/whatsapp/model";
import { makeColombianUser } from "~/core/identity/rules";
import { MigrationSqlClient } from "~/shell/db/client";
import {
  associateWhatsAppIdentity,
  insertUser,
  insertWhatsAppIdentity,
  resolveWhatsAppCaller,
} from "~/shell/identity/repo";
import { ApiHarness } from "~/shell/testing/api-harness";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import { evaluateConsentGate } from "./consent-gate";
import {
  appendConsentRecord,
  claimConsentDisclosureDelivery,
  findPendingConsentExchange,
  hasCurrentOnboardingConsent,
  observeConsentRecords,
  recordConsentDisclosureDelivery,
} from "./repo";

const acceptedPhone = E164PhoneNumber.make("+573009990001");
const declinedPhone = E164PhoneNumber.make("+573009990002");
const expiredPhone = E164PhoneNumber.make("+573009990003");
const rollbackPhone = E164PhoneNumber.make("+573009990004");
const returningPhone = E164PhoneNumber.make("+573009990005");
const changedPhone = E164PhoneNumber.make("+573009990006");
const outOfOrderPhone = E164PhoneNumber.make("+573009990007");
const replayCollisionPhone = E164PhoneNumber.make("+573009990008");
const initiatingReplayPhone = E164PhoneNumber.make("+573009990009");
const returningUserId = UserId.make("f1d1a000-0000-4000-8000-0000000008c1");
const receivedAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");

const recordClaimedDisclosure = Effect.fn("test.recordClaimedDisclosure")(function* (input: {
  readonly exchangeId: PendingConsentExchangeId;
  readonly message: ProviderMessageEvidence;
  readonly deliveredAt: DateTime.Utc;
}) {
  const claim = yield* claimConsentDisclosureDelivery(input.exchangeId, input.deliveredAt);
  if (Option.isNone(claim)) return yield* Effect.die("missing disclosure claim");
  return yield* recordConsentDisclosureDelivery({ ...input, claimId: claim.value.claimId });
});

const message = (
  providerMessageId: string
): { channel: string; provider: string; providerMessageId: string } => ({
  channel: "whatsapp",
  provider: "kapso",
  providerMessageId,
});

const textTurn = (
  phoneNumber: E164PhoneNumber,
  text: string,
  providerMessageId: string
): {
  caller: WhatsAppCaller;
  content: { _tag: "Text"; text: string };
  message: { channel: string; provider: string; providerMessageId: string };
  receivedAt: DateTime.Utc;
} => ({
  caller: testWhatsAppCaller(phoneNumber),
  content: { _tag: "Text" as const, text },
  message: message(providerMessageId),
  receivedAt,
});

const withReceivedAt = (
  turn: ReturnType<typeof textTurn>,
  receivedAt: DateTime.Utc
): ReturnType<typeof textTurn> => ({
  ...turn,
  receivedAt,
});

const clearPhone = (
  phoneNumber: E164PhoneNumber
): Effect.Effect<void, SqlError.SqlError, MigrationSqlClient> =>
  Effect.gen(function* () {
    const sql = yield* MigrationSqlClient;
    const caller = testWhatsAppCaller(phoneNumber);
    yield* sql`
      DELETE FROM consent_records WHERE subject_user_id IN (
        SELECT user_id FROM whatsapp_identities WHERE phone_number = ${phoneNumber}
      )
    `;
    yield* sql`DELETE FROM pending_consent_exchanges
      WHERE business_portfolio_id = ${caller.businessPortfolioId}
        AND business_scoped_user_id = ${caller.businessScopedUserId}`;
    yield* sql`DELETE FROM users WHERE id IN (
      SELECT user_id FROM whatsapp_identities WHERE phone_number = ${phoneNumber}
    )`;
  });

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })("consent gate", (it) => {
  it.effect(
    "discloses before processing, requires explicit acceptance, and accepts atomically",
    () =>
      Effect.gen(function* () {
        yield* clearPhone(changedPhone);
        yield* clearPhone(acceptedPhone);

        const disclosure = yield* evaluateConsentGate(
          textTurn(acceptedPhone, "almuerzo 25 mil", "wamid.gate-initial")
        );
        expect(disclosure._tag).toBe("SendDisclosure");
        if (disclosure._tag !== "SendDisclosure") return;
        expect(disclosure.text).toContain("https://fidyapp.com/politica");
        expect(Option.isNone(yield* resolveWhatsAppCaller(testWhatsAppCaller(acceptedPhone)))).toBe(
          true
        );

        yield* recordClaimedDisclosure({
          exchangeId: disclosure.exchangeId,
          message: message("wamid.gate-disclosure"),
          deliveredAt: DateTime.makeUnsafe("2026-08-01T12:00:01Z"),
        });

        const ambiguous = yield* evaluateConsentGate(
          withReceivedAt(
            textTurn(acceptedPhone, "sí", "wamid.gate-bare-si"),
            DateTime.makeUnsafe("2026-08-01T12:00:02Z")
          )
        );
        expect(ambiguous._tag).toBe("ClarifyDecision");
        expect(
          Option.isSome(yield* findPendingConsentExchange(testWhatsAppCaller(acceptedPhone)))
        ).toBe(true);

        const accepted = yield* evaluateConsentGate(
          withReceivedAt(
            textTurn(acceptedPhone, "Acepto", "wamid.gate-acceptance"),
            DateTime.makeUnsafe("2026-08-01T12:00:03Z")
          )
        );
        expect(accepted._tag).toBe("Accepted");
        if (accepted._tag !== "Accepted") return;
        expect(
          Option.isNone(yield* findPendingConsentExchange(testWhatsAppCaller(acceptedPhone)))
        ).toBe(true);
        expect(yield* hasCurrentOnboardingConsent(accepted.userId)).toBe(true);
        expect(yield* observeConsentRecords(accepted.userId)).toHaveLength(1);

        // The acceptance turn is terminal at the gate and is never returned as Proceed.
        expect(accepted).not.toHaveProperty("inboundMessage");

        const replay = yield* evaluateConsentGate(
          withReceivedAt(
            textTurn(acceptedPhone, "Acepto", "wamid.gate-acceptance"),
            DateTime.makeUnsafe("2026-08-01T12:00:04Z")
          )
        );
        expect(replay).toMatchObject({ _tag: "Accepted", userId: accepted.userId });
        expect(yield* observeConsentRecords(accepted.userId)).toHaveLength(1);

        yield* clearPhone(replayCollisionPhone);
        const crossIdentityReplay = yield* evaluateConsentGate(
          withReceivedAt(
            textTurn(replayCollisionPhone, "Acepto", "wamid.gate-acceptance"),
            DateTime.makeUnsafe("2026-08-01T12:00:04Z")
          )
        );
        expect(crossIdentityReplay._tag).toBe("ClarifyDecision");
        expect(
          Option.isNone(yield* resolveWhatsAppCaller(testWhatsAppCaller(replayCollisionPhone)))
        ).toBe(true);

        const nextTurn = yield* evaluateConsentGate(
          withReceivedAt(
            textTurn(acceptedPhone, "cena 30 mil", "wamid.gate-next"),
            DateTime.makeUnsafe("2026-08-01T12:00:05Z")
          )
        );
        expect(nextTurn).toEqual({ _tag: "Proceed", userId: accepted.userId });

        const evidenceBeforeChange = yield* observeConsentRecords(accepted.userId);
        yield* associateWhatsAppIdentity(accepted.userId, {
          ...testWhatsAppCaller(changedPhone),
          verifiedAt: DateTime.makeUnsafe("2026-08-01T12:00:06Z"),
        });
        expect(Option.isNone(yield* resolveWhatsAppCaller(testWhatsAppCaller(acceptedPhone)))).toBe(
          true
        );
        expect(yield* resolveWhatsAppCaller(testWhatsAppCaller(changedPhone))).toEqual(
          Option.some(accepted.userId)
        );
        expect(yield* observeConsentRecords(accepted.userId)).toEqual(evidenceBeforeChange);
        expect(evidenceBeforeChange[0]?.disclosureMessage).toEqual(
          message("wamid.gate-disclosure")
        );
        expect(evidenceBeforeChange[0]?.decisionMessage).toEqual(message("wamid.gate-acceptance"));
      })
  );

  it.effect("rolls back User creation when the consent ledger append fails", () =>
    Effect.gen(function* () {
      yield* clearPhone(rollbackPhone);
      const sql = yield* MigrationSqlClient;
      yield* sql`DROP TRIGGER IF EXISTS reject_gate_test_consent ON consent_records`;
      yield* sql`DROP FUNCTION IF EXISTS reject_gate_test_consent()`;
      yield* sql`
        CREATE FUNCTION reject_gate_test_consent() RETURNS trigger AS $$
        BEGIN
          IF NEW.decision_provider_message_id = 'wamid.rollback-decision' THEN
            RAISE EXCEPTION 'injected consent append failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `;
      yield* sql`
        CREATE TRIGGER reject_gate_test_consent
        BEFORE INSERT ON consent_records
        FOR EACH ROW EXECUTE FUNCTION reject_gate_test_consent()
      `;

      const exercise = Effect.gen(function* () {
        const disclosure = yield* evaluateConsentGate(
          textTurn(rollbackPhone, "dato privado", "wamid.rollback-initial")
        );
        if (disclosure._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
        yield* recordClaimedDisclosure({
          exchangeId: disclosure.exchangeId,
          message: message("wamid.rollback-disclosure"),
          deliveredAt: DateTime.makeUnsafe("2026-08-01T12:00:01Z"),
        });

        const acceptance = yield* Effect.exit(
          evaluateConsentGate(
            withReceivedAt(
              textTurn(rollbackPhone, "Acepto", "wamid.rollback-decision"),
              DateTime.makeUnsafe("2026-08-01T12:00:02Z")
            )
          )
        );
        expect(Exit.isFailure(acceptance)).toBe(true);
        expect(Option.isNone(yield* resolveWhatsAppCaller(testWhatsAppCaller(rollbackPhone)))).toBe(
          true
        );
        expect(
          Option.isSome(yield* findPendingConsentExchange(testWhatsAppCaller(rollbackPhone)))
        ).toBe(true);
      });

      yield* exercise.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* sql`DROP TRIGGER IF EXISTS reject_gate_test_consent ON consent_records`;
            yield* sql`DROP FUNCTION IF EXISTS reject_gate_test_consent()`;
          }).pipe(Effect.orDie)
        )
      );
    })
  );

  it.effect("restores onboarding consent without replacing an existing User", () =>
    Effect.gen(function* () {
      yield* clearPhone(returningPhone);
      const user = yield* makeColombianUser(returningUserId, { createdAt: receivedAt });
      yield* insertUser(returningUserId, user);
      yield* insertWhatsAppIdentity(returningUserId, {
        ...testWhatsAppCaller(returningPhone),
        verifiedAt: receivedAt,
      });

      const disclosure = yield* evaluateConsentGate(
        textTurn(returningPhone, "volver", "wamid.returning-initial")
      );
      if (disclosure._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
      yield* recordClaimedDisclosure({
        exchangeId: disclosure.exchangeId,
        message: message("wamid.returning-disclosure"),
        deliveredAt: DateTime.makeUnsafe("2026-08-01T12:00:01Z"),
      });

      const accepted = yield* evaluateConsentGate(
        withReceivedAt(
          textTurn(returningPhone, "Acepto", "wamid.returning-decision"),
          DateTime.makeUnsafe("2026-08-01T12:00:02Z")
        )
      );
      expect(accepted).toMatchObject({ _tag: "Accepted", userId: returningUserId });
      const [grant] = yield* observeConsentRecords(returningUserId);
      if (grant === undefined) return yield* Effect.die("missing consent grant");
      yield* appendConsentRecord(
        ConsentRecord.make({
          ...grant,
          id: ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000008c1"),
          event: { _tag: "Revoked", grantId: grant.id },
          decisionMessage: message("wamid.returning-revocation"),
          occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:03Z"),
        })
      );
      const revokedReplay = yield* evaluateConsentGate(
        withReceivedAt(
          textTurn(returningPhone, "Acepto", "wamid.returning-decision"),
          DateTime.makeUnsafe("2026-08-01T12:00:04Z")
        )
      );
      expect(revokedReplay._tag).toBe("SendDisclosure");
      if (revokedReplay._tag !== "SendDisclosure") return;
      yield* recordClaimedDisclosure({
        exchangeId: revokedReplay.exchangeId,
        message: message("wamid.returning-current-disclosure"),
        deliveredAt: DateTime.makeUnsafe("2026-08-01T12:00:05Z"),
      });
      const replayDuringCurrentExchange = yield* evaluateConsentGate(
        withReceivedAt(
          textTurn(returningPhone, "Acepto", "wamid.returning-decision"),
          DateTime.makeUnsafe("2026-08-01T12:00:06Z")
        )
      );
      expect(replayDuringCurrentExchange._tag).toBe("ClarifyDecision");
    })
  );

  it.effect("rejects acceptance received before disclosure delivery", () =>
    Effect.gen(function* () {
      yield* clearPhone(outOfOrderPhone);
      const disclosure = yield* evaluateConsentGate(
        withReceivedAt(
          textTurn(outOfOrderPhone, "hola", "wamid.out-of-order-initial"),
          DateTime.makeUnsafe("2026-08-01T11:59:59Z")
        )
      );
      if (disclosure._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
      yield* recordClaimedDisclosure({
        exchangeId: disclosure.exchangeId,
        message: message("wamid.out-of-order-disclosure"),
        deliveredAt: DateTime.makeUnsafe("2026-08-01T12:00:02Z"),
      });

      const result = yield* evaluateConsentGate(
        withReceivedAt(
          textTurn(outOfOrderPhone, "Acepto", "wamid.out-of-order-acceptance"),
          DateTime.makeUnsafe("2026-08-01T12:00:01Z")
        )
      );
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`
        SELECT id FROM consent_records
        WHERE decision_provider_message_id = 'wamid.out-of-order-acceptance'
      `;

      expect(result._tag).toBe("ClarifyDecision");
      expect(Option.isNone(yield* resolveWhatsAppCaller(testWhatsAppCaller(outOfOrderPhone)))).toBe(
        true
      );
      expect(
        Option.isSome(yield* findPendingConsentExchange(testWhatsAppCaller(outOfOrderPhone)))
      ).toBe(true);
      expect(rows).toHaveLength(0);
    })
  );

  it.effect("never accepts a redelivered message that initiated its disclosure", () =>
    Effect.gen(function* () {
      yield* clearPhone(initiatingReplayPhone);
      const initialMessageId = "wamid.initiating-acceptance";
      const first = yield* evaluateConsentGate(
        withReceivedAt(
          textTurn(initiatingReplayPhone, "Acepto", initialMessageId),
          DateTime.makeUnsafe("2026-08-01T12:00:00Z")
        )
      );
      if (first._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
      yield* recordClaimedDisclosure({
        exchangeId: first.exchangeId,
        message: message("wamid.initiating-disclosure"),
        deliveredAt: DateTime.makeUnsafe("2026-08-01T12:00:01Z"),
      });

      const replay = yield* evaluateConsentGate(
        withReceivedAt(
          textTurn(initiatingReplayPhone, "Acepto", initialMessageId),
          DateTime.makeUnsafe("2026-08-01T12:00:02Z")
        )
      );
      expect(replay._tag).toBe("ClarifyDecision");
      expect(
        Option.isNone(yield* resolveWhatsAppCaller(testWhatsAppCaller(initiatingReplayPhone)))
      ).toBe(true);

      const replacement = yield* evaluateConsentGate(
        withReceivedAt(
          textTurn(initiatingReplayPhone, "Acepto", initialMessageId),
          DateTime.makeUnsafe("2026-08-02T12:00:00Z")
        )
      );
      expect(replacement._tag).toBe("SendDisclosure");
      if (replacement._tag !== "SendDisclosure") return;
      yield* recordClaimedDisclosure({
        exchangeId: replacement.exchangeId,
        message: message("wamid.replacement-disclosure"),
        deliveredAt: DateTime.makeUnsafe("2026-08-02T12:00:01Z"),
      });
      const delayedReplay = yield* evaluateConsentGate(
        withReceivedAt(
          textTurn(initiatingReplayPhone, "Acepto", initialMessageId),
          DateTime.makeUnsafe("2026-08-02T12:00:02Z")
        )
      );
      expect(delayedReplay._tag).toBe("ClarifyDecision");
      expect(
        Option.isNone(yield* resolveWhatsAppCaller(testWhatsAppCaller(initiatingReplayPhone)))
      ).toBe(true);
    })
  );

  it.effect("deletes all pending state on decline without creating a User", () =>
    Effect.gen(function* () {
      yield* clearPhone(declinedPhone);
      const initiatedAt = DateTime.makeUnsafe("2026-08-01T12:34:54.789Z");
      const declinedAt = DateTime.makeUnsafe("2026-08-01T12:34:56.789Z");
      const disclosure = yield* evaluateConsentGate(
        withReceivedAt(textTurn(declinedPhone, "hola", "wamid.decline-initial"), initiatedAt)
      );
      if (disclosure._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
      yield* recordClaimedDisclosure({
        exchangeId: disclosure.exchangeId,
        message: message("wamid.decline-disclosure"),
        deliveredAt: DateTime.makeUnsafe("2026-08-01T12:34:55.789Z"),
      });

      const declined = yield* evaluateConsentGate(
        withReceivedAt(textTurn(declinedPhone, "No acepto", "wamid.decline-decision"), declinedAt)
      );
      expect(declined._tag).toBe("Declined");
      expect(
        Option.isNone(yield* findPendingConsentExchange(testWhatsAppCaller(declinedPhone)))
      ).toBe(true);
      expect(Option.isNone(yield* resolveWhatsAppCaller(testWhatsAppCaller(declinedPhone)))).toBe(
        true
      );

      const sql = yield* SqlClient.SqlClient;
      const ResidualRows = Schema.Struct({
        users: Schema.Int,
        identities: Schema.Int,
        consentRecords: Schema.Int,
        transactions: Schema.Int,
        transcripts: Schema.Int,
        audits: Schema.Int,
        agentTokens: Schema.Int,
      });
      const residual = yield* SqlSchema.findOne({
        Request: Schema.Struct({
          phoneNumber: E164PhoneNumber,
          initiatedAt: Schema.DateTimeUtcFromDate,
          declinedAt: Schema.DateTimeUtcFromDate,
        }),
        Result: ResidualRows,
        execute: ({ declinedAt: decisionTime, initiatedAt: startTime, phoneNumber }) => sql`
          WITH declined_users AS (
            SELECT id FROM users
            WHERE created_at >= ${startTime} AND created_at <= ${decisionTime}
          )
          SELECT
            (SELECT count(*)::int FROM declined_users) AS users,
            (SELECT count(*)::int FROM whatsapp_identities
              WHERE phone_number = ${phoneNumber}) AS identities,
            (SELECT count(*)::int FROM consent_records
              WHERE disclosure_provider_message_id = 'wamid.decline-disclosure'
                OR decision_provider_message_id = 'wamid.decline-decision') AS "consentRecords",
            (SELECT count(*)::int FROM transactions
              WHERE user_id IN (SELECT id FROM declined_users)) AS transactions,
            (SELECT count(*)::int FROM transcript_entries
              WHERE user_id IN (SELECT id FROM declined_users)) AS transcripts,
            (SELECT count(*)::int FROM audit_log_entries
              WHERE user_id IN (SELECT id FROM declined_users)) AS audits,
            (SELECT count(*)::int FROM agent_tokens
              WHERE user_id IN (SELECT id FROM declined_users)) AS "agentTokens"
        `,
      })({ declinedAt, initiatedAt, phoneNumber: declinedPhone });
      expect(residual).toEqual({
        users: 0,
        identities: 0,
        consentRecords: 0,
        transactions: 0,
        transcripts: 0,
        audits: 0,
        agentTokens: 0,
      });
    })
  );

  it.effect("expires at 24 hours and starts a fresh disclosure without retaining content", () =>
    Effect.gen(function* () {
      yield* clearPhone(expiredPhone);
      const first = yield* evaluateConsentGate(
        textTurn(expiredPhone, "dato privado original", "wamid.expired-initial")
      );
      if (first._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
      yield* recordClaimedDisclosure({
        exchangeId: first.exchangeId,
        message: message("wamid.expired-disclosure"),
        deliveredAt: DateTime.makeUnsafe("2026-08-01T12:00:01Z"),
      });

      const replacement = yield* evaluateConsentGate(
        withReceivedAt(
          textTurn(expiredPhone, "Acepto", "wamid.expired-acceptance"),
          DateTime.makeUnsafe("2026-08-02T12:00:00Z")
        )
      );
      expect(replacement._tag).toBe("SendDisclosure");
      if (replacement._tag !== "SendDisclosure") return;
      expect(replacement.exchangeId).not.toBe(first.exchangeId);

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* SqlSchema.findAll({
        Request: Schema.Struct({
          businessPortfolioId: WhatsAppCaller.fields.businessPortfolioId,
          businessScopedUserId: WhatsAppCaller.fields.businessScopedUserId,
        }),
        Result: Schema.Struct({ serialized: Schema.String }),
        execute: (caller) => sql`
          SELECT row_to_json(pending_consent_exchanges)::text AS serialized
          FROM pending_consent_exchanges
          WHERE business_portfolio_id = ${caller.businessPortfolioId}
            AND business_scoped_user_id = ${caller.businessScopedUserId}
        `,
      })(testWhatsAppCaller(expiredPhone));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.serialized).not.toContain("dato privado original");
      expect(rows[0]?.serialized).not.toContain("wamid.expired-initial");
      expect(rows[0]?.serialized).toContain("wamid.expired-acceptance");
    })
  );
});
