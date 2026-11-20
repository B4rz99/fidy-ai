import type {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import type { PendingConsentExchangeId } from "../../src/shell/consent/contract";
import { Data } from "effect";

export type WhatsAppCallerLookup = Readonly<{
  db: D1Database;
  portfolioId: WhatsAppBusinessPortfolioId;
  bsuid: WhatsAppBusinessScopedUserId;
}>;

export class IdentityUnavailable extends Data.TaggedError("IdentityUnavailable")<{}> {}

export type IdentityStatement = OwnedStatement;

export type WhatsAppAssociationSubject = Readonly<{
  userId: UserId;
  portfolioId: WhatsAppBusinessPortfolioId;
  bsuid: WhatsAppBusinessScopedUserId;
}>;

export type UserCreationInput = Readonly<{
  db: D1Database;
  userId: UserId;
  createdAtMs: number;
}>;

export type UserCreationStatements = Readonly<{
  createUser: D1PreparedStatement;
}>;

export type OnboardingWhatsAppAssociation = UserCreationInput &
  Readonly<{ exchangeId: PendingConsentExchangeId }>;
