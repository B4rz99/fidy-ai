import { type DateTime, Schema } from "effect";
import { UserContext, type UserId } from "../../../src/core/identity/contract";
import { RecurringDigestItem, RecurringDigestReport } from "../../../src/core/insights/contract";

export const maximumItems = 128;
export const ItemJson = Schema.fromJsonString(Schema.toCodecJson(RecurringDigestItem));
export const ContextJson = Schema.fromJsonString(Schema.toCodecJson(UserContext));
export const ReportJson = Schema.fromJsonString(Schema.toCodecJson(RecurringDigestReport));
export type Scope = Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>;
export const Scan = Schema.Struct({
  cursor: Schema.OptionFromNullOr(Schema.String),
  complete: Schema.Literals([0, 1]),
});
export const Stage = Schema.Struct({
  confirmation_id: Schema.String,
  confirmed_at_ms: Schema.Int,
  context_json: ContextJson,
  item_json: Schema.OptionFromNullOr(ItemJson),
  eligible: Schema.Literals(["eligible", "suppressed", "invalid", "legacy"]),
});
export type StageView = typeof Stage.Type;
