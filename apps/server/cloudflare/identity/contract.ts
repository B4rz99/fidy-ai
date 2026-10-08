import type {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import type { PendingConsentExchangeId } from "../../src/shell/consent/contract";
import { Data } from "effect";

/** An established caller lookup supplies coordination context, never reusable authority. */
export type WhatsAppCallerLookup = Readonly<{
  db: D1Database;
  portfolioId: WhatsAppBusinessPortfolioId;
  bsuid: WhatsAppBusinessScopedUserId;
}>;

/** The Identity boundary failed without disclosing private rows or database details. */
export class IdentityUnavailable extends Data.TaggedError("IdentityUnavailable")<{}> {}

/** Parameterized action owned by a caller; preparation does not execute or grant authority. */
export type IdentityStatement = OwnedStatement;

/** Stable User and the exact established WhatsApp caller to recheck at use. */
export type WhatsAppAssociationSubject = Readonly<{
  userId: UserId;
  portfolioId: WhatsAppBusinessPortfolioId;
  bsuid: WhatsAppBusinessScopedUserId;
}>;

/** New stable User prepared for an atomic onboarding unit; preparation grants no authority. */
export type UserCreationInput = Readonly<{
  db: D1Database;
  userId: UserId;
  createdAtMs: number;
}>;

/** Commit both actions with Consent, Recovery and the originating owner's final proof guard. */
export type UserCreationStatements = Readonly<{
  createUser: D1PreparedStatement;
  startTrial: D1PreparedStatement;
}>;

/** The originating accepted channel exchange, never a caller-supplied WhatsApp contact or pair. */
export type OnboardingWhatsAppAssociation = UserCreationInput &
  Readonly<{ exchangeId: PendingConsentExchangeId }>;
