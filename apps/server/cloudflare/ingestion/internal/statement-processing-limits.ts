import { statementParserLimits } from "../../../src/shell/ingestion/contract";

/** One User-coordinated activity finalizes at most this many derived rows. */
export const statementChunkSize = 32;

/** Bound the full Workflow by the same admitted row ceiling enforced inside both parsers. */
export const maximumStatementChunkActivities = Math.ceil(
  statementParserLimits.maximumRows / statementChunkSize
);

/** Maximum encoded derived evidence retained for one original statement purpose. */
export const maximumMaterializedStatementBytes = 16_777_216;

/** Bounded encoded column headings retained with one materialization identity. */
export const maximumMaterializedHeaderBytes = 524_288;

/** Source parsing reservations are durable; ambiguous reservation responses consume one slot. */
export const maximumStatementSourceParses = 3;
