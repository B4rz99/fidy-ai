import { Effect, Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/reference";
import {
  type IdentityStatement,
  IdentityUnavailable,
  type WhatsAppAssociationSubject,
  type WhatsAppCallerLookup,
} from "../contract";

const UserRow = Schema.Struct({ user_id: UserId });

export const resolveCaller = ({
  db,
  portfolioId,
  bsuid,
}: WhatsAppCallerLookup): Effect.Effect<Option.Option<UserId>, IdentityUnavailable> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare("SELECT user_id FROM whatsapp_identities WHERE portfolio_id = ? AND bsuid = ?")
        .bind(portfolioId, bsuid)
        .first(),
    catch: () => new IdentityUnavailable(),
  }).pipe(
    Effect.map((row) =>
      Option.map(Schema.decodeUnknownOption(UserRow)(row), ({ user_id }) => user_id)
    )
  );

export const associationQuery = ({
  userId,
  portfolioId,
  bsuid,
}: WhatsAppAssociationSubject): IdentityStatement => ({
  sql: "SELECT user_id AS userId FROM whatsapp_identities WHERE user_id = ? AND portfolio_id = ? AND bsuid = ?",
  params: [userId, portfolioId, bsuid],
});

export const associationProjection = ({
  userId,
  statement,
}: Readonly<{ userId: UserId; statement: IdentityStatement }>): IdentityStatement => ({
  sql: `WITH identity_associations AS (
    SELECT user_id AS userId, portfolio_id AS businessPortfolioId, bsuid AS businessScopedUserId
    FROM whatsapp_identities WHERE user_id = ?
  ) ${statement.sql}`,
  params: [userId, ...statement.params],
});
