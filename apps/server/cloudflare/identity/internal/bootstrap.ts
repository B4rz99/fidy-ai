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
      .prepare(`INSERT INTO users (id, service_market, locale, time_zone, created_at_ms, trial_started_at_ms, trial_ends_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        user.id,
        user.serviceMarket,
        user.locale,
        user.timeZone,
        createdAtMs,
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
      sql: `UPDATE users SET whatsapp_portfolio_id=caller.portfolio_id,whatsapp_bsuid=caller.bsuid,whatsapp_verified_at_ms=?2
        FROM accepted_consent_callers AS caller WHERE users.id=?1 AND caller.exchange_id=?3
        AND users.whatsapp_portfolio_id IS NULL`,
      params: [userId, createdAtMs, exchangeId],
    },
  });
