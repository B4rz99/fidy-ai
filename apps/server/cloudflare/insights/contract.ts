import { Data, Schema } from "effect";
import { UserId } from "@fidy/server/identity-reference";
import { InsightEventId } from "@fidy/server/insights-contract";

/** A coordination hint only; processing must re-read the event inside this User's boundary. */
export const DueInsight = Schema.Struct({ userId: UserId, id: InsightEventId });
export type DueInsight = typeof DueInsight.Type;

/** Insight state could not be read or retained completely; it is not an absent occurrence. */
export class InsightUnavailable extends Data.TaggedError("InsightUnavailable") {}
