import { Effect, Option, Schema } from "effect";
import { whatsAppAssociationQuery } from "../../../src/shell/identity/operations";
import { UserId } from "../../../src/core/identity/contract";
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
        .prepare(
          "SELECT id AS user_id FROM users WHERE whatsapp_portfolio_id = ? AND whatsapp_bsuid = ?"
        )
        .bind(portfolioId, bsuid)
        .first(),
    catch: () => new IdentityUnavailable(),
  }).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.succeed(Option.none<UserId>())
        : Schema.decodeUnknownEffect(UserRow)(row).pipe(
            Effect.map(({ user_id }) => Option.some(user_id)),
            Effect.mapError(() => new IdentityUnavailable())
          )
    )
  );

export const associationQuery = ({
  userId,
  portfolioId,
  bsuid,
}: WhatsAppAssociationSubject): IdentityStatement =>
  whatsAppAssociationQuery({
    userId,
    caller: { businessPortfolioId: portfolioId, businessScopedUserId: bsuid },
  });

export const associationProjection = ({
  userId,
  statement,
}: Readonly<{ userId: UserId; statement: IdentityStatement }>): IdentityStatement => ({
  sql: `WITH identity_associations AS (
    SELECT id AS userId, whatsapp_portfolio_id AS businessPortfolioId, whatsapp_bsuid AS businessScopedUserId
    FROM users WHERE id = ? AND whatsapp_portfolio_id IS NOT NULL
  ) ${statement.sql}`,
  params: [userId, ...statement.params],
});
