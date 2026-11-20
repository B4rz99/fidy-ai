import type { UserId } from "../../../src/core/identity/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { prepareConsentAction } from "../../consent/operations";

export const prepareTranscriptAssociations = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    transcript: OwnedStatement;
    links: OwnedStatement;
  }>
): D1PreparedStatement =>
  prepareConsentAction({
    db: input.db,
    subject: { _tag: "User", userId: input.userId },
    requirement: "active",
    statement: {
      sql: `UPDATE insight_events SET transcript_id=p.id,transcript_kind='insight'
      FROM (${input.transcript.sql}) AS p JOIN (${input.links.sql}) AS l ON l.user_id=p.user_id
      WHERE insight_events.user_id=p.user_id AND insight_events.id=l.insight_event_id
        AND insight_events.user_id=? AND insight_events.transcript_id IS NULL`,
      params: [...input.transcript.params, ...input.links.params, input.userId],
    },
  });

export const transcriptAssociationQuery = (
  input: Readonly<{
    userId: UserId;
    insightEventId: string;
  }>
): OwnedStatement => ({
  sql: "SELECT user_id,transcript_id FROM insight_events WHERE user_id=? AND id=? AND transcript_kind='insight' AND transcript_id IS NOT NULL",
  params: [input.userId, input.insightEventId],
});
