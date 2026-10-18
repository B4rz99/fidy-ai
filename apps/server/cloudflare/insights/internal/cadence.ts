import type { DateTime } from "effect";

const minuteMs = 60_000;
const summaryIntervalMinutes = 5;
const retentionIntervalMinutes = 60;

export const summariesDue = (now: DateTime.Utc): boolean =>
  Math.floor(now.epochMilliseconds / minuteMs) % summaryIntervalMinutes === 0;

export const evidenceRetentionDue = (now: DateTime.Utc): boolean =>
  Math.floor(now.epochMilliseconds / minuteMs) % retentionIntervalMinutes === 0;
