import { DateTime } from "effect";
import type { WebSessionDeadlines } from "./contract";

export const calculateWebSessionDeadlines = (pairedAt: DateTime.Utc): WebSessionDeadlines => ({
  freshUntil: DateTime.addDuration(pairedAt, "10 minutes"),
  idleExpiresAt: DateTime.addDuration(pairedAt, "30 days"),
  hardExpiresAt: DateTime.addDuration(pairedAt, "90 days"),
});

export const webSessionIdleRenewalCandidate = (usedAt: DateTime.Utc): DateTime.Utc =>
  DateTime.addDuration(usedAt, "30 days");

export const renewWebSessionIdleDeadline = ({
  currentIdleExpiresAt,
  hardExpiresAt,
  usedAt,
}: Readonly<{
  currentIdleExpiresAt: DateTime.Utc;
  hardExpiresAt: DateTime.Utc;
  usedAt: DateTime.Utc;
}>): DateTime.Utc =>
  DateTime.min(
    hardExpiresAt,
    DateTime.max(currentIdleExpiresAt, webSessionIdleRenewalCandidate(usedAt))
  );
