import { Schema } from "effect";

/** Stable identity of one browser-authenticated WebSession. */
export const WebSessionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("WebSessionId"))
  .annotate({ identifier: "WebSessionId" });
export type WebSessionId = typeof WebSessionId.Type;

/** Random opaque browser bearer; only its SHA-256 digest may be persisted. */
export const WebSessionBearer = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u))
  .pipe(Schema.brand("WebSessionBearer"))
  .annotate({ identifier: "WebSessionBearer" });
export type WebSessionBearer = typeof WebSessionBearer.Type;
