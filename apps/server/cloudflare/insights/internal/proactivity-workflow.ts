import { type Effect, Schema } from "effect";
import { type ProactivityDeliveryWork, ProactivityWorkflowId } from "../contract";

const weeklyIdentity = Schema.TemplateLiteralParser(ProactivityWorkflowId.members[0].parts);
const categoryIdentity = Schema.TemplateLiteralParser(ProactivityWorkflowId.members[1].parts);

/** The producer and operational projection encode the same owner-declared identity grammar. */
export const proactivityWorkflowId = (
  work: ProactivityDeliveryWork
): Effect.Effect<typeof ProactivityWorkflowId.Type, Schema.SchemaError> =>
  work.kind === "proactivity-delivery"
    ? Schema.encodeEffect(categoryIdentity)([
        categoryIdentity.parts[0],
        work.userId,
        categoryIdentity.parts[2],
        work.id,
      ])
    : Schema.encodeEffect(weeklyIdentity)([
        weeklyIdentity.parts[0],
        work.userId,
        weeklyIdentity.parts[2],
        work.kind,
        weeklyIdentity.parts[4],
        work.kind === "weekly-summary" ? work.insightEventId : work.id,
      ]);
