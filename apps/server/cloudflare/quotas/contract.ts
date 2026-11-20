import { Data } from "effect";
import type { AllowanceKind } from "../../src/core/quotas/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

export class QuotaRetentionUnavailable extends Data.TaggedError("QuotaRetentionUnavailable") {}

export type ConsumptionInput = Readonly<{
  db: D1Database;
  userId: string;
  allowance: AllowanceKind;
  identity: string;
  current: number;
  authority: OwnedStatement;
}>;
