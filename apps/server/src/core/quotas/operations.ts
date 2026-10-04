import { DateTime } from "effect";
import type { AccessTier } from "../access-tier/contract";
import {
  type AllowanceKind,
  type AllowanceMeter,
  type AllowancePeriod,
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

/** Returns the fixed Free entitlement for one directly measurable unit. */
export const allowanceLimit = (allowance: AllowanceKind): number => limits[allowance];

/** Projects a decoded consumption count without granting authorization or reserving capacity. */
export const allowanceMeter = (
  input: Readonly<{
    allowance: AllowanceKind;
    accessTier: AccessTier;
    consumed: number;
    now: DateTime.Utc;
  }>
): AllowanceMeter =>
  input.accessTier === "pro"
    ? { _tag: "Uncapped" }
    : {
        _tag: "Limited",
        limit: limits[input.allowance],
        consumed: input.consumed,
        remaining: Math.max(0, limits[input.allowance] - input.consumed),
        period: allowancePeriod(input.now),
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
