import { type Effect, Schema } from "effect";
import { type ProactivityDeliveryWork, ProactivityWorkflowId } from "../contract";

const identity = Schema.TemplateLiteralParser(ProactivityWorkflowId.parts);

/** The producer and operational projection encode the same owner-declared identity grammar. */
export const proactivityWorkflowId = (
  work: ProactivityDeliveryWork
): Effect.Effect<typeof ProactivityWorkflowId.Type, Schema.SchemaError> =>
  Schema.encodeEffect(identity)([
    identity.parts[0],
    work.userId,
    identity.parts[2],
    work.kind,
    identity.parts[4],
    work.kind === "weekly-summary" ? work.insightEventId : work.id,
  ]);
