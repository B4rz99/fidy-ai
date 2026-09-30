import type { UserId } from "../../src/core/identity/contract";
import type { EmailAddress } from "@fidy/server/client";
import type { Effect, Option } from "effect";

/** Closed owner-constructed proof-ownership guard for one pending pairing and explicit stable User. */
export type PairingEmailOwnership = Readonly<{
  predicate: string;
  bindings: readonly [string, UserId];
}>;

/** A User-scoped credential read composable with the caller's other D1 statements. */
export type VerifiedEmailRead = Readonly<{
  statement: D1PreparedStatement;
  decode: (result: D1Result) => Effect.Effect<Option.Option<EmailAddress>, void>;
}>;

/** A verified, current mailbox proof. It carries no mailbox or digest; D1 consumes it at commit. */
export type PreparedOnboardingCredential = Readonly<{
  enrollmentId: string;
  pendingConsentExchangeId: string;
  /** Compose both statements with stable User creation. Never execute either outside that atomic batch. */
  statements: (
    input: Readonly<{ userId: UserId; verifiedAtMs: number }>
  ) => readonly [D1PreparedStatement, D1PreparedStatement];
}>;
