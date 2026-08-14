import { Schema } from "effect";

/** Stable identity of one User-authorized PAT grant. */
export const PATId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PATId"))
  .annotate({ identifier: "PATId" });
export type PATId = typeof PATId.Type;

/** Stable identity of one internal HostedTurnToken grant. */
export const HostedTurnTokenId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("HostedTurnTokenId"))
  .annotate({ identifier: "HostedTurnTokenId" });
export type HostedTurnTokenId = typeof HostedTurnTokenId.Type;

/** A stable internal UUID naming either supported token-grant variant. */
export const TokenId = Schema.Union([PATId, HostedTurnTokenId]).annotate({ identifier: "TokenId" });
export type TokenId = typeof TokenId.Type;
