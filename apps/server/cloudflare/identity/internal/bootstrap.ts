import { DateTime } from "effect";
import { makeColombianUser } from "../../../src/core/identity/operations";
import { UserId } from "../../../src/core/identity/contract";
import { prepareAcceptedConsentCaller } from "../../consent/operations";
import type {
  OnboardingWhatsAppAssociation,
  UserCreationInput,
  UserCreationStatements,
} from "../contract";

export const userCreationStatements = ({
  db,
  userId,
  createdAtMs,
}: UserCreationInput): UserCreationStatements => {
  const user = makeColombianUser({
    userId: UserId.make(userId),
    createdAt: DateTime.makeUnsafe(createdAtMs),
  });
  return {
    createUser: db
      .prepare(`INSERT INTO users (id, service_market, locale, time_zone, created_at_ms)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(user.id, user.serviceMarket, user.locale, user.timeZone, createdAtMs),
    startTrial: db
      .prepare("INSERT INTO trial_periods (user_id, started_at_ms, ends_at_ms) VALUES (?, ?, ?)")
      .bind(
        user.id,
        user.trialPeriod.startedAt.epochMilliseconds,
        user.trialPeriod.endsAt.epochMilliseconds
      ),
  };
};

export const onboardingWhatsAppStatement = ({
  db,
  userId,
  exchangeId,
  createdAtMs,
}: OnboardingWhatsAppAssociation): D1PreparedStatement =>
  prepareAcceptedConsentCaller({
    db,
    statement: {
      sql: `INSERT INTO whatsapp_identities (user_id, portfolio_id, bsuid, verified_at_ms)
        SELECT ?, portfolio_id, bsuid, ? FROM accepted_consent_callers WHERE exchange_id = ?`,
      params: [userId, createdAtMs, exchangeId],
    },
  });
