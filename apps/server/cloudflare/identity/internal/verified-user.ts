import { DateTime, Effect } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { makeColombianUser } from "../../../src/core/identity/operations";
import type { VerifiedUserInput, VerifiedUserStatements } from "../contract";

export const verifiedUserStatements = ({
  db,
  userId,
  exchangeId,
  now,
}: VerifiedUserInput): VerifiedUserStatements => {
  const user = Effect.runSync(
    makeColombianUser(UserId.make(userId), { createdAt: DateTime.makeUnsafe(now) })
  );
  return {
    user: db
      .prepare(`INSERT INTO users (id, service_market, locale, time_zone, created_at_ms)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(user.id, user.serviceMarket, user.locale, user.timeZone, now),
    association: db
      .prepare(`INSERT INTO whatsapp_identities (user_id, portfolio_id, bsuid, verified_at_ms)
      SELECT ?, portfolio_id, bsuid, ? FROM pending_consent_exchanges WHERE id = ? AND state = 'accepted'`)
      .bind(user.id, now, exchangeId),
  };
};
