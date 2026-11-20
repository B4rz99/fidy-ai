import { statementParserLimits } from "../../../src/shell/ingestion/contract";

export const statementChunkSize = 32;

export const maximumStatementChunkActivities = Math.ceil(
  statementParserLimits.maximumRows / statementChunkSize
);

export const maximumMaterializedStatementBytes = 16_777_216;

export const maximumMaterializedHeaderBytes = 524_288;

export const maximumStatementSourceParses = 3;
