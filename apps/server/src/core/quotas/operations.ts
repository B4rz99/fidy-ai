import { DateTime } from "effect";
import type { AccessTier } from "~/core/access-tier/contract";
import {
  type AllowanceKind,
  type AllowanceMeter,
  type AllowancePeriod,
  type QuotaStatus,
  freeAllowanceLimits,
} from "./contract";

const bogota = DateTime.zoneMakeNamedUnsafe("America/Bogota");
const limits = freeAllowanceLimits;

/** Returns the commercial period containing now; midnight Bogotá is 05:00 UTC at launch. */
export const allowancePeriod = (now: DateTime.Utc): AllowancePeriod => {
  const start = DateTime.startOf(DateTime.setZone(now, bogota), "month");
  return {
    startsAt: DateTime.toUtc(start),
    resetsAt: DateTime.toUtc(DateTime.add(start, { months: 1 })),
  };
};

/** Projects four decoded counts under one calendar period, without granting authority or capacity. */
export const projectQuotaStatus = (
  input: Readonly<{
    accessTier: AccessTier;
    consumed: Readonly<Record<AllowanceKind, number>>;
    now: DateTime.Utc;
  }>
): QuotaStatus => {
  if (input.accessTier === "pro") {
    return {
      accessTier: "pro",
      forwardedEmails: { _tag: "Uncapped" },
      mediaSubmissions: { _tag: "Uncapped" },
      hostedHistoryTurns: { _tag: "Uncapped" },
      canonicalCalls: { _tag: "Uncapped" },
    };
  }
  const period = allowancePeriod(input.now);
  const meter = (allowance: AllowanceKind): AllowanceMeter => ({
    _tag: "Limited",
    limit: limits[allowance],
    consumed: input.consumed[allowance],
    remaining: Math.max(0, limits[allowance] - input.consumed[allowance]),
    period,
  });
  return {
    accessTier: "free",
    forwardedEmails: meter("forwarded_email"),
    mediaSubmissions: meter("media_submission"),
    hostedHistoryTurns: meter("hosted_history_turn"),
    canonicalCalls: meter("canonical_call"),
  };
};

/** Decides one new unit after replay handling. A caller must recheck the cap with its guarded acceptance commit. */
export const decideConsumption = (
  input: Readonly<{
    allowance: AllowanceKind;
    accessTier: AccessTier;
    consumed: number;
    now: DateTime.Utc;
  }>
):
  | Readonly<{ _tag: "Consume"; remaining: number }>
  | Readonly<{ _tag: "Uncapped" }>
  | Readonly<{ _tag: "Exhausted"; allowance: AllowanceKind; resetsAt: DateTime.Utc }> => {
  if (input.accessTier === "pro") return { _tag: "Uncapped" };
  const limit = limits[input.allowance];
  return input.consumed >= limit
    ? {
        _tag: "Exhausted",
        allowance: input.allowance,
        resetsAt: allowancePeriod(input.now).resetsAt,
      }
    : { _tag: "Consume", remaining: limit - input.consumed - 1 };
};
