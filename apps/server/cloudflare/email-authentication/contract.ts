import type { UserId } from "../../src/core/identity/contract";

/** A verified, current mailbox proof. It carries no mailbox or digest; D1 consumes it at commit. */
export type PreparedOnboardingCredential = Readonly<{
  enrollmentId: string;
  pendingConsentExchangeId: string;
  /** Compose both statements with stable User creation. Never execute either outside that atomic batch. */
  statements: (
    input: Readonly<{ userId: UserId; verifiedAtMs: number }>
  ) => readonly [D1PreparedStatement, D1PreparedStatement];
}>;
