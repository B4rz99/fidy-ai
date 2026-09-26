import { statementParserLimits } from "@fidy/server/statement-parser";

/** One User-coordinated activity writes at most this many rows and rereads at most one staged file. */
export const statementChunkSize = 32;

/** Bound the full Workflow by the same admitted row ceiling enforced inside both parsers. */
export const maximumStatementChunkActivities = Math.ceil(
  statementParserLimits.maximumRows / statementChunkSize
);
