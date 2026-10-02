import type { DateTime } from "effect";

/** Freshness and idle authority end no later than the immutable hard expiry of one WebSession. */
export type WebSessionDeadlines = Readonly<{
  freshUntil: DateTime.Utc;
  idleExpiresAt: DateTime.Utc;
  hardExpiresAt: DateTime.Utc;
}>;
