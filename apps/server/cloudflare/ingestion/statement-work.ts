import { StatementSubmissionId } from "@fidy/server/statement-staging";
import { Schema } from "effect";

/** Secret-free, versioned identity shared by Queue, Workflow, and the User coordinator. */
export const StatementWork = Schema.Struct({
  version: Schema.Literal(1),
  userId: Schema.String.check(Schema.isUUID()),
  submissionId: StatementSubmissionId,
});

/** Only the private Worker binding may send this coordinator activity. */
export const StatementCoordinatorActivity = Schema.Union([
  Schema.TaggedStruct("StatementWork", StatementWork.fields),
  Schema.TaggedStruct("StatementFailed", StatementWork.fields),
]);
