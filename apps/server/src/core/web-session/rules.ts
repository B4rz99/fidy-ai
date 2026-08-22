import { DateTime } from "effect";

/** Fixed lifetimes established when a browser pairing becomes one WebSession. */
export const calculateWebSessionDeadlines = (
  pairedAt: DateTime.Utc
): Readonly<{
  freshUntil: DateTime.Utc;
  idleExpiresAt: DateTime.Utc;
  hardExpiresAt: DateTime.Utc;
}> => ({
  freshUntil: DateTime.addDuration(pairedAt, "10 minutes"),
  idleExpiresAt: DateTime.addDuration(pairedAt, "30 days"),
  hardExpiresAt: DateTime.addDuration(pairedAt, "90 days"),
});

/** Derives the requested idle deadline for one accepted use before persistence invariants apply. */
export const webSessionIdleRenewalCandidate = (usedAt: DateTime.Utc): DateTime.Utc =>
  DateTime.addDuration(usedAt, "30 days");

/** Renews idle use monotonically for thirty days, capped by immutable hard expiry. */
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
