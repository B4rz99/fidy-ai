import { prepareCurrentUser } from "../../src/shell/identity/operations";
import type { CurrentUserResponse } from "../../src/shell/identity/contract";
import { IdentityUnavailable } from "./contract";
import { bootstrapStatements } from "./internal/bootstrap";
import { Effect, type Option } from "effect";
import type { UserId } from "../../src/core/identity/contract";
import type {
  IdentityStatement,
  VerifiedIdentityInput,
  VerifiedIdentityStatements,
  WhatsAppAssociationSubject,
  WhatsAppCallerLookup,
} from "./contract";
import { associationProjection, associationQuery, resolveCaller } from "./internal/association";

/**
 * Resolve only a persisted Business Portfolio and BSUID association. Contact values and provider
 * ids never substitute for that pair. This pre-coordination lookup is not authorization: every
 * protected action must recheck the exact User association in its own authoritative D1 unit.
 */
export const findWhatsAppUser = (
  input: WhatsAppCallerLookup
): Effect.Effect<Option.Option<UserId>, IdentityUnavailable> => resolveCaller(input);

/** Query the exact stable User/caller association at the protected action's decision instant. */
export const whatsAppIdentityQuery = (input: WhatsAppAssociationSubject): IdentityStatement =>
  associationQuery(input);

/**
 * Compose one User's current WhatsApp associations with a caller-owned D1 action. The published
 * identity_associations relation contains only userId, businessPortfolioId and businessScopedUserId.
 * Keep the caller's exact pair restriction in its action; the projection is re-evaluated in that
 * same statement, including after a prepared action waits. No contacts or provider evidence escape.
 */
export const prepareWhatsAppIdentity = (
  input: Readonly<{ db: D1Database; userId: UserId; statement: IdentityStatement }>
): D1PreparedStatement => {
  const query = associationProjection(input);
  return input.db.prepare(query.sql).bind(...query.params);
};

/**
 * Prepare Identity's part of verified onboarding, including the one original 168-hour TrialPeriod.
 * Commit these actions in the same caller-owned D1 batch as the verified mailbox, historical
 * Consent, recovery credential and final current-proof assertion. No stable identity may commit
 * before that assertion. Preparation neither consumes a proof nor establishes reusable authority.
 */
export const prepareVerifiedIdentity = (input: VerifiedIdentityInput): VerifiedIdentityStatements =>
  bootstrapStatements(input);

/**
 * Load one authenticated User's full canonical projection with their current Consent grant.
 * This read grants no authority: the caller must recheck its exact live credential before release.
 * Missing, invalid or inaccessible state fails closed without exposing persistence details.
 */
export const readCurrentUser = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: UserId }>): Effect.Effect<
  CurrentUserResponse,
  IdentityUnavailable
> =>
  Effect.gen(function* () {
    const read = yield* prepareCurrentUser(userId);
    const result = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(read.statement.sql)
          .bind(...read.statement.params)
          .all(),
      catch: () => new IdentityUnavailable(),
    });
    return yield* read.decode(result.results);
  }).pipe(Effect.mapError(() => new IdentityUnavailable()));
