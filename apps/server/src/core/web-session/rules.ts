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
