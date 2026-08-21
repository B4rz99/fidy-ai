import { Schema } from "effect";

/** Stable identity of one browser-authenticated WebSession. */
export const WebSessionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("WebSessionId"))
  .annotate({ identifier: "WebSessionId" });
export type WebSessionId = typeof WebSessionId.Type;
