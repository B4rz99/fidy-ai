import { Data, DateTime } from "effect";
import type { AccessTier } from "~/core/access-tier/contract";
import {
  type AllowanceKind,
  type AllowanceMeter,
  type AllowancePeriod,
  type QuotaStatus,
  freeAllowanceLimits,
} from "./contract";

const Meter = Data.taggedEnum<AllowanceMeter>();

const bogota = DateTime.zoneMakeNamedUnsafe("America/Bogota");

const limits = freeAllowanceLimits;

export const allowancePeriod = (now: DateTime.Utc): AllowancePeriod => {
  const start = DateTime.startOf(DateTime.setZone(now, bogota), "month");

  return {
    startsAt: DateTime.toUtc(start),
    resetsAt: DateTime.toUtc(DateTime.add(start, { months: 1 })),
  };
};

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
      forwardedEmails: Meter.Uncapped(),
      mediaSubmissions: Meter.Uncapped(),
      hostedHistoryTurns: Meter.Uncapped(),
      canonicalCalls: Meter.Uncapped(),
    };
  }

  const period = allowancePeriod(input.now);

  const meter = (allowance: AllowanceKind): AllowanceMeter =>
    Meter.Limited({
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

export type ConsumptionDecision = Data.TaggedEnum<{
  Consume: { readonly remaining: number };
  Uncapped: {};
  Exhausted: { readonly allowance: AllowanceKind; readonly resetsAt: DateTime.Utc };
}>;

export const ConsumptionDecision = Data.taggedEnum<ConsumptionDecision>();

export const decideConsumption = (
  input: Readonly<{
    allowance: AllowanceKind;
    accessTier: AccessTier;
    consumed: number;
    now: DateTime.Utc;
  }>
): ConsumptionDecision => {
  if (input.accessTier === "pro") return ConsumptionDecision.Uncapped();
  const limit = limits[input.allowance];

  return input.consumed >= limit
    ? ConsumptionDecision.Exhausted({
        allowance: input.allowance,
        resetsAt: allowancePeriod(input.now).resetsAt,
      })
    : ConsumptionDecision.Consume({ remaining: limit - input.consumed - 1 });
};
