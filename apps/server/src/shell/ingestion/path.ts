/**
 * Path of the Core Worker statement byte staging transport. It is named here rather than in the
 * canonical API because it is deliberately not a canonical operation (#788, ADR 0028): the ingress
 * and edge policy import it, agents and MCP tools never see it, and every response it returns is a
 * non-authoritative staged reference that grants no extraction eligibility.
 */
export const statementStagingPath = "/ingestion/statements/bytes";
