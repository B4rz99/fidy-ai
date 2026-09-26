/** Public portable seams for one hosted Turn, independent of its Cloudflare adapters. */
export { AgentReply, InboundMessage } from "./message";
export { assembleWorkingContext } from "./working-context";
export type { SessionTranscriptEntry } from "./working-context";
export { decideHostedAdmission } from "~/core/transcript/turn-admission";
export type {
  HostedAdmissionRequest,
  HostedAdmissionState,
} from "~/core/transcript/turn-admission";
export { HostedAgentSessionConsentBasis } from "~/core/transcript/hosted-agent-session";
export { HostedAgentSessionId } from "~/core/transcript/reference";
export {
  AssistantTranscriptEntry,
  FailedTurnTranscriptEntry,
  InterruptedTurnTranscriptEntry,
  TranscriptEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  TurnFailureReason,
  UserTranscriptEntry,
} from "~/core/transcript/model";
export { DisclosureSnapshot } from "~/core/consent/model";
export { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
export { UserId } from "~/core/identity/reference";
export { memoriesFromRows, memoryRowsQuery } from "~/shell/memory/query";
