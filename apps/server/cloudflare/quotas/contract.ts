import type { AllowanceKind } from "../../src/core/quotas/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

/** Composes consumption into an existing same-User D1 acceptance unit, without a nested transaction. */
export type ConsumptionInput = Readonly<{
  db: D1Database;
  userId: string;
  allowance: AllowanceKind;
  identity: string;
  current: number;
  /** Owner-held live authority query projecting userId. It must include the applicable Consent purpose. */
  authority: OwnedStatement;
}>;
