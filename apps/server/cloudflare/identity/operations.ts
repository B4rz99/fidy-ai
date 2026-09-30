import { Effect, type Option } from "effect";
import type { UserContext, UserId } from "../../src/core/identity/contract";
import {
  IdentityUnavailable,
  type PreparedIdentityRead,
  type UserContextInput,
  type VerifiedUserInput,
  type VerifiedUserStatements,
  type WhatsAppResolutionInput,
} from "./contract";
import { prepareContext } from "./internal/user-context";
import { verifiedUserStatements } from "./internal/verified-user";
import { prepareWhatsAppResolution } from "./internal/whatsapp-user";

/**
 * Prepare stable User creation and its accepted WhatsApp association. The caller must commit both
 * with verified email, Consent, the initial trial, and proof consumption in one D1 batch.
 * Preparation alone creates no authority and makes no write.
 */
export const prepareVerifiedUser = (input: VerifiedUserInput): VerifiedUserStatements =>
  verifiedUserStatements(input);

/** Resolve the exact Portfolio-scoped association before coordination; the coordinator must recheck it. */
export const findWhatsAppUser = (
  input: WhatsAppResolutionInput
): Effect.Effect<Option.Option<UserId>, IdentityUnavailable> => {
  const query = prepareWhatsAppResolution(input);
  return Effect.tryPromise({
    try: () => query.statement.first(),
    catch: () => new IdentityUnavailable(),
  }).pipe(Effect.map(query.decode));
};

/** Compose one explicit User context read into a caller-owned D1 batch; decode returns no storage rows. */
export const prepareUserContext = (input: UserContextInput): PreparedIdentityRead<UserContext> =>
  prepareContext(input);

/** Read current independent interpretation values for an already resolved stable User. Not authorization. */
export const findUserContext = (
  input: UserContextInput
): Effect.Effect<Option.Option<UserContext>, IdentityUnavailable> => {
  const query = prepareUserContext(input);
  return Effect.tryPromise({
    try: () => query.statement.first(),
    catch: () => new IdentityUnavailable(),
  }).pipe(Effect.map(query.decode));
};
