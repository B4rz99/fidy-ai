/** Public relations whose rows are owned by a User and therefore require forced RLS. */
export const userTableNames = [
  "agent_tokens",
  "audit_log_entries",
  "consent_records",
  "dashboards",
  "insight_delivery_attempts",
  "insight_events",
  "insight_money_groups",
  "keyword_rules",
  "source_attestations",
  "transactions",
  "transcript_entries",
  "users",
  "whatsapp_identities",
] as const;
