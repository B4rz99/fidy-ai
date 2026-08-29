import { createTransactions } from "./0001-create-transactions";
import { createIdentitiesAndTokens } from "./0002-create-identities-and-tokens";
import { createAuditLog } from "./0003-create-audit-log";
import { createCategorizedTransactions } from "./0004-categorized-transactions";
import { createInsights } from "./0005-create-insights";
import { createDashboards } from "./0006-create-dashboards";
import { createTranscripts } from "./0007-create-transcripts";
import { rowLevelSecurity } from "./0009-row-level-security";
import { createConsentLedger } from "./0010-create-consent-ledger";
import { bindPendingConsentInitiator } from "./0011-bind-pending-consent-initiator";
import { createWhatsAppChannel } from "./0012-create-whatsapp-channel";
import { claimConsentDisclosureDelivery } from "./0013-claim-consent-disclosure-delivery";
import { optionalTransactionCounterparty } from "./0014-optional-transaction-counterparty";
import { whatsappBsuidIdentity } from "./0015-whatsapp-bsuid-identity";
import { agentConfirmationConsumptions } from "./0016-agent-confirmation-consumptions";
import { recoverConsentDisclosureDelivery } from "./0017-recover-consent-disclosure-delivery";
import { whatsappDurablePropagation } from "./0018-whatsapp-durable-propagation";
import { userAccess } from "./0019-user-access";
import { conversationContinuity } from "./0020-conversation-continuity";
import { createMemories } from "./0021-create-memories";
import { statementIngestion } from "./0022-statement-ingestion";
import { memoryRevisions } from "./0023-memory-revisions";
import { compactedConversations } from "./0024-compacted-conversations";
import { monthlyBudgets } from "./0025-monthly-budgets";
import { browserLoginPairings } from "./0026-browser-login-pairings";
import { webSessions } from "./0027-web-sessions";
import { persistedSchemaReconciliation } from "./0028-persisted-schema-reconciliation";
import { subscriptionPriceRevisions } from "./0029-subscription-price-revisions";
import { manualPATIssuance } from "./0030-manual-pat-issuance";
import { retrySafeManualPATIssuance } from "./0031-retry-safe-manual-pat-issuance";
import { dashboardTransactionAccess } from "./0032-dashboard-transaction-access";
import { fixedPATLifetimes } from "./0033-fixed-pat-lifetimes";
import { verifiedEmailOnboarding } from "./0034-verified-email-onboarding";
import { patPairings } from "./0035-pat-pairings";
import { verifiedEmailReplacement } from "./0036-verified-email-replacement";
import { patManagement } from "./0037-pat-management";
import { whatsappConfirmationEvidence } from "./0038-whatsapp-confirmation-evidence";
import { verifiedEmailLogin } from "./0039-verified-email-login";
import { supportRecovery } from "./0040-support-recovery";
import { subscriptionPriceVocabulary } from "./0041-subscription-price-vocabulary";
import { wompiCardEnrollments } from "./0042-wompi-card-enrollments";
import { emailIngestion } from "./0043-email-ingestion";

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
  "0002_create_identities_and_tokens": createIdentitiesAndTokens,
  "0003_create_audit_log": createAuditLog,
  "0004_categorized_transactions": createCategorizedTransactions,
  "0005_create_insights": createInsights,
  "0006_create_dashboards": createDashboards,
  "0007_create_transcripts": createTranscripts,
  "0009_row_level_security": rowLevelSecurity,
  "0010_create_consent_ledger": createConsentLedger,
  "0011_bind_pending_consent_initiator": bindPendingConsentInitiator,
  "0012_create_whatsapp_channel": createWhatsAppChannel,
  "0013_claim_consent_disclosure_delivery": claimConsentDisclosureDelivery,
  "0014_optional_transaction_counterparty": optionalTransactionCounterparty,
  "0015_whatsapp_bsuid_identity": whatsappBsuidIdentity,
  "0016_agent_confirmation_consumptions": agentConfirmationConsumptions,
  "0017_recover_consent_disclosure_delivery": recoverConsentDisclosureDelivery,
  "0018_whatsapp_durable_propagation": whatsappDurablePropagation,
  "0019_user_access": userAccess,
  "0020_conversation_continuity": conversationContinuity,
  "0021_create_memories": createMemories,
  "0022_statement_ingestion": statementIngestion,
  "0023_memory_revisions": memoryRevisions,
  "0024_compacted_conversations": compactedConversations,
  "0025_monthly_budgets": monthlyBudgets,
  "0026_browser_login_pairings": browserLoginPairings,
  "0027_web_sessions": webSessions,
  "0028_persisted_schema_reconciliation": persistedSchemaReconciliation,
  "0029_subscription_price_revisions": subscriptionPriceRevisions,
  "0030_manual_pat_issuance": manualPATIssuance,
  "0031_retry_safe_manual_pat_issuance": retrySafeManualPATIssuance,
  "0032_dashboard_transaction_access": dashboardTransactionAccess,
  "0033_fixed_pat_lifetimes": fixedPATLifetimes,
  "0034_verified_email_onboarding": verifiedEmailOnboarding,
  "0035_pat_pairings": patPairings,
  "0036_verified_email_replacement": verifiedEmailReplacement,
  "0037_pat_management": patManagement,
  "0038_whatsapp_confirmation_evidence": whatsappConfirmationEvidence,
  "0039_verified_email_login": verifiedEmailLogin,
  "0040_support_recovery": supportRecovery,
  "0041_subscription_price_vocabulary": subscriptionPriceVocabulary,
  "0042_wompi_card_enrollments": wompiCardEnrollments,
  "0043_email_ingestion": emailIngestion,
};
