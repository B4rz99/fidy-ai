import { Data, type Option } from "effect";
import type {
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";

/** Safe unavailability without platform, query, or personal details. */
export class IdentityUnavailable extends Data.TaggedError("IdentityUnavailable") {}

/** A caller-owned D1 read whose decoded result is an Identity projection, never a storage row. */
export type PreparedIdentityRead<A> = Readonly<{
  statement: D1PreparedStatement;
  decode: (raw: unknown) => Option.Option<A>;
}>;
export type UserContextInput = Readonly<{ db: D1Database; userId: string }>;
export type WhatsAppResolutionInput = Readonly<{
  db: D1Database;
  portfolioId: WhatsAppBusinessPortfolioId;
  bsuid: WhatsAppBusinessScopedUserId;
}>;
export type VerifiedUserInput = Readonly<{
  db: D1Database;
  userId: string;
  exchangeId: string;
  now: number;
}>;
/** Both belong to the same proof-consumption unit; neither commits independently. */
export type VerifiedUserStatements = Readonly<{
  user: D1PreparedStatement;
  association: D1PreparedStatement;
}>;
