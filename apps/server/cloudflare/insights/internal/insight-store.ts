import { Option, Schema } from "effect";
import { InsightEvent, InsightEventId } from "../../../src/core/insights/contract";

export const maximumPendingInsights = 64;

export const pendingCursor = (
  url: URL
): Option.Option<Readonly<{ scheduledAt: Option.Option<number>; id: string }>> => {
  const raw = url.searchParams.get("cursor");

  if (raw === null) return Option.some({ scheduledAt: Option.none(), id: "" });
  const [scheduledAt, id] = raw.split("|");

  const timestamp = Schema.decodeUnknownOption(Schema.toCodecJson(InsightEvent.fields.scheduledAt))(
    scheduledAt
  );

  if (
    raw.split("|").length !== 2 ||
    Option.isNone(timestamp) ||
    Option.isNone(Schema.decodeUnknownOption(InsightEventId)(id))
  ) {
    return Option.none();
  }

  return Option.some({ scheduledAt: Option.some(timestamp.value.epochMilliseconds), id: id ?? "" });
};
