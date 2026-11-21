import { DateTime, Schema } from "effect";
import { expect, it } from "vitest";
import {
  ConsumptionDecision,
  allowancePeriod,
  decideConsumption,
  projectQuotaStatus,
} from "~/core/quotas/operations";
import { type AllowanceKind, AllowanceMeter } from "~/core/quotas/contract";

const Meter = AllowanceMeter.pipe(Schema.toTaggedUnion("_tag")).cases;

const consumption = (
  allowance: AllowanceKind,
  consumed: number
): Readonly<Record<AllowanceKind, number>> => ({
  forwarded_email: 0,
  media_submission: 0,
  hosted_history_turn: 0,
  canonical_call: 0,
  [allowance]: consumed,
});

it("refuses a full Free meter at the exact next Bogotá month boundary", () => {
  const now = DateTime.makeUnsafe("2026-08-01T04:59:59Z");
  const period = allowancePeriod(now);
  expect(DateTime.formatIso(period.startsAt)).toBe("2026-07-01T05:00:00.000Z");
  expect(DateTime.formatIso(period.resetsAt)).toBe("2026-08-01T05:00:00.000Z");

  const decision = decideConsumption({
    allowance: "canonical_call",
    accessTier: "free",
    consumed: 50,
    now,
  });

  expect(decision).toEqual(
    ConsumptionDecision.Exhausted({ allowance: "canonical_call", resetsAt: period.resetsAt })
  );
});

it.each([
  ["forwarded_email", 30, "forwardedEmails"],
  ["media_submission", 2, "mediaSubmissions"],
  ["hosted_history_turn", 2, "hostedHistoryTurns"],
  ["canonical_call", 50, "canonicalCalls"],
] as const)(
  "counts one accepted %s against its independent Free allowance",
  (allowance, limit, key) => {
    const now = DateTime.makeUnsafe("2026-08-01T05:00:00Z");

    const period = {
      startsAt: DateTime.makeUnsafe("2026-08-01T05:00:00Z"),
      resetsAt: DateTime.makeUnsafe("2026-09-01T05:00:00Z"),
    };

    for (const consumed of [0, limit - 1]) {
      const input = { allowance, accessTier: "free" as const, consumed, now };
      expect(
        projectQuotaStatus({ ...input, consumed: consumption(allowance, consumed) })[key]
      ).toEqual(Meter.Limited.make({ limit, consumed, remaining: limit - consumed, period }));
      expect(decideConsumption(input)).toEqual(
        ConsumptionDecision.Consume({ remaining: limit - consumed - 1 })
      );
    }

    for (const consumed of [limit, limit + 1]) {
      const input = { allowance, accessTier: "free" as const, consumed, now };
      expect(
        projectQuotaStatus({ ...input, consumed: consumption(allowance, consumed) })[key]
      ).toEqual(Meter.Limited.make({ limit, consumed, remaining: 0, period }));
      expect(decideConsumption(input)).toEqual(
        ConsumptionDecision.Exhausted({ allowance, resetsAt: period.resetsAt })
      );
    }

    const pro = { allowance, accessTier: "pro" as const, consumed: limit + 1, now };
    expect(projectQuotaStatus({ ...pro, consumed: consumption(allowance, limit + 1) })).toEqual({
      accessTier: "pro",
      forwardedEmails: Meter.Uncapped.make({}),
      mediaSubmissions: Meter.Uncapped.make({}),
      hostedHistoryTurns: Meter.Uncapped.make({}),
      canonicalCalls: Meter.Uncapped.make({}),
    });
    expect(decideConsumption(pro)).toEqual(ConsumptionDecision.Uncapped());
  }
);
