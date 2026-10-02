import type {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "@fidy/server/identity-reference";
import type { OwnedStatement } from "../../src/shell/_shared/owned-statement";
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

/** Stable identity created only alongside verified mailbox, Consent, recovery and proof consumption. */
export type VerifiedIdentityInput = Readonly<{
  db: D1Database;
  userId: UserId;
  exchangeId: string;
  createdAtMs: number;
}>;

/** Three owner actions to compose, without executing, in the caller's verified-onboarding batch. */
export type VerifiedIdentityStatements = Readonly<{
  createUser: D1PreparedStatement;
  associateCaller: D1PreparedStatement;
  startTrial: D1PreparedStatement;
}>;
