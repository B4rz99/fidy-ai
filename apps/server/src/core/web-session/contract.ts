import { type DateTime, Schema } from "effect";

export const WebSessionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("WebSessionId"))
  .annotate({ identifier: "WebSessionId" });

export type WebSessionId = typeof WebSessionId.Type;

export const WebSessionBearer = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u))
  .pipe(Schema.brand("WebSessionBearer"))
  .annotate({ identifier: "WebSessionBearer" });

export type WebSessionBearer = typeof WebSessionBearer.Type;

export type WebSessionDeadlines = Readonly<{
  freshUntil: DateTime.Utc;
  idleExpiresAt: DateTime.Utc;
  hardExpiresAt: DateTime.Utc;
}>;
