import { prepareCurrentUser } from "../../src/shell/identity/operations";
import type { CurrentUserResponse } from "../../src/shell/identity/contract";
import { IdentityUnavailable } from "./contract";
import { onboardingWhatsAppStatement, userCreationStatements } from "./internal/bootstrap";
import { Effect, type Option } from "effect";
import type { UserId } from "../../src/core/identity/contract";
import type {
  IdentityStatement,
  OnboardingWhatsAppAssociation,
  UserCreationInput,
  UserCreationStatements,
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
 * Prepare one new Colombian User and its original 168-hour TrialPeriod without channel evidence.
 * Commit these actions in the same onboarding D1 batch as Consent, recovery credential and the
 * originating proof owner's final current-proof assertion. No stable identity may commit
 * before that assertion. Preparation neither consumes a proof nor establishes reusable authority.
 */
export const prepareUserCreation = (input: UserCreationInput): UserCreationStatements =>
  userCreationStatements(input);

/**
 * Associate the new User only with the exact accepted Consent exchange's originating WhatsApp
 * caller. Commit with User creation, Consent, Recovery and mailbox proof consumption; the final
 * proof guard must refuse stale, foreign or missing exchange evidence in that same atomic unit.
 * Preparation neither verifies a proof nor authorizes reassociation of an established User.
 */
export const prepareOnboardingWhatsAppAssociation = (
  input: OnboardingWhatsAppAssociation
): D1PreparedStatement => onboardingWhatsAppStatement(input);

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
