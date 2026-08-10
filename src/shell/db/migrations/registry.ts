import { createTransactions } from "./0001-create-transactions";
import { createIdentitiesAndAgentTokens } from "./0002-create-identities-and-agent-tokens";
import { createAuditLog } from "./0003-create-audit-log";
import { createCategorizedTransactions } from "./0004-categorized-transactions";
import { createInsights } from "./0005-create-insights";
import { createDashboards } from "./0006-create-dashboards";
import { createTranscripts } from "./0007-create-transcripts";
import { hostedAgentTokens } from "./0008-hosted-agent-tokens";
import { rowLevelSecurity } from "./0009-row-level-security";
import { createConsentLedger } from "./0010-create-consent-ledger";
import { bindPendingConsentInitiator } from "./0011-bind-pending-consent-initiator";
import { createWhatsAppChannel } from "./0012-create-whatsapp-channel";
import { claimConsentDisclosureDelivery } from "./0013-claim-consent-disclosure-delivery";
import { optionalTransactionCounterparty } from "./0014-optional-transaction-counterparty";
import { whatsappBsuidIdentity } from "./0015-whatsapp-bsuid-identity";
import { agentConfirmationConsumptions } from "./0016-agent-confirmation-consumptions";
import { recoverConsentDisclosureDelivery } from "./0017-recover-consent-disclosure-delivery";

/**
 * The explicit index ARCHITECTURE.md §7 calls for: one ordered, append-only
 * record naming every migration file, consumed by the Effect migrator. Keys
 * follow the `<id>_<name>` convention the migrator sorts by, and `fromRecord`
 * silently drops any key that does not match it.
 *
 * Not a barrel — it re-exports nothing and is the composition point itself.
 */
export const migrations = {
  "0001_create_transactions": createTransactions,
  "0002_create_identities_and_agent_tokens": createIdentitiesAndAgentTokens,
  "0003_create_audit_log": createAuditLog,
  "0004_categorized_transactions": createCategorizedTransactions,
  "0005_create_insights": createInsights,
  "0006_create_dashboards": createDashboards,
  "0007_create_transcripts": createTranscripts,
  "0008_hosted_agent_tokens": hostedAgentTokens,
  "0009_row_level_security": rowLevelSecurity,
  "0010_create_consent_ledger": createConsentLedger,
  "0011_bind_pending_consent_initiator": bindPendingConsentInitiator,
  "0012_create_whatsapp_channel": createWhatsAppChannel,
  "0013_claim_consent_disclosure_delivery": claimConsentDisclosureDelivery,
  "0014_optional_transaction_counterparty": optionalTransactionCounterparty,
  "0015_whatsapp_bsuid_identity": whatsappBsuidIdentity,
  "0016_agent_confirmation_consumptions": agentConfirmationConsumptions,
  "0017_recover_consent_disclosure_delivery": recoverConsentDisclosureDelivery,
};
