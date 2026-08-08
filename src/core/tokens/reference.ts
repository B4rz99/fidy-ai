import { Schema } from "effect";

/** A stable internal UUID naming one AgentToken grant. */
export const AgentTokenId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("AgentTokenId"))
  .annotate({ identifier: "AgentTokenId" });
export type AgentTokenId = typeof AgentTokenId.Type;
