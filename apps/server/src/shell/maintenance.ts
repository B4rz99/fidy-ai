import { Layer } from "effect";
import { BrowserLoginEvidenceRetentionLive } from "~/shell/browser-login/handlers";
import { WhatsAppRetentionLive } from "~/shell/channels/whatsapp/worker";
import { BrowserPairingEmailRetentionLive } from "~/shell/email-authentication/authentication-retention";
import { EmailReplacementRetentionLive } from "~/shell/email-authentication/replacement-retention";
import { EvidenceRetentionLive } from "./evidence-retention";
import {
  ForwardedEmailEvidenceRetentionLive,
  ForwardedEmailExecutionRetentionLive,
} from "~/shell/ingestion/forwarded-email-ingestion";
import { StatementIngestionRetentionLive } from "~/shell/ingestion/worker";
import { OnboardingRetentionLive } from "~/shell/onboarding/retention";
import { SupportRecoveryRetentionLive } from "~/shell/recovery/retention";
import { PATPairingMaintenanceLive } from "~/shell/tokens/pairing-maintenance";

/**
 * All process-local expiry and retention scheduling. Each owner keeps its deletion and lifecycle
 * semantics; this composition only groups Work whose missed tick may delay maintenance but cannot
 * authorize otherwise-invalid behavior.
 */
export const MaintenanceLive = Layer.mergeAll(
  BrowserLoginEvidenceRetentionLive,
  BrowserPairingEmailRetentionLive,
  EmailReplacementRetentionLive,
  EvidenceRetentionLive,
  ForwardedEmailEvidenceRetentionLive,
  ForwardedEmailExecutionRetentionLive,
  OnboardingRetentionLive,
  PATPairingMaintenanceLive,
  StatementIngestionRetentionLive,
  SupportRecoveryRetentionLive,
  WhatsAppRetentionLive
);
