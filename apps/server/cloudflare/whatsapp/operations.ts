import { Effect } from "effect";
import * as proactivity from "./internal/proactivity-delivery";

import {
  expireWeeklyQuestions as expireQuestions,
  findWeeklyQuestionUser as findQuestionUser,
  weeklyQuestionDeliveryQuery as questionDeliveryQuery,
  readWeeklyReplyChoice as readReplyChoice,
  reconcileWeeklyQuestion as reconcileQuestion,
  recordWeeklyQuestionSend as recordQuestion,
  stageWeeklyQuestion as stageQuestion,
  startWeeklyQuestion as startQuestion,
} from "./internal/weekly-question";

import { WhatsAppUnavailable } from "./contract";
import { inspectWhatsApp as inspect } from "./internal/operational-observation";
import {
  expireWhatsAppEvidence as expireWhatsAppEvidenceOwned,
  prepareWhatsAppInbound as prepareWhatsAppInboundOwned,
  prepareWhatsAppWorkCleanup as prepareWhatsAppWorkCleanupOwned,
  recoverWhatsAppDelivery as recoverWhatsAppDeliveryOwned,
  whatsAppRecoveryPriority as recoveryPriority,
  whatsAppCompletionGuard as whatsAppCompletionGuardOwned,
  whatsAppInterruptionGuard as whatsAppInterruptionGuardOwned,
  whatsAppProposalTimes as whatsAppProposalTimesOwned,
} from "./internal/turn-evidence";
import { expireVoiceRefusals as expireRefusals } from "./internal/voice-retention";
import {
  reconcileWhatsAppStatus as reconcileWhatsAppStatusOwned,
  recordWhatsAppSend as recordWhatsAppSendOwned,
  recordWhatsAppStatus as recordWhatsAppStatusOwned,
  rejectUnstartedWhatsAppDelivery as rejectUnstartedWhatsAppDeliveryOwned,
  stageWhatsAppDelivery as stageWhatsAppDeliveryOwned,
  startWhatsAppSend as startWhatsAppSendOwned,
} from "./internal/whatsapp-delivery";
import {
  classifyWhatsAppAdmission as classifyWhatsAppAdmissionOwned,
  findWhatsAppDeliveryUser as findWhatsAppDeliveryUserOwned,
  findWhatsAppReplay as findWhatsAppReplayOwned,
  isWhatsAppWindowOpen as isWhatsAppWindowOpenOwned,
  readWhatsAppPendingWork as readWhatsAppPendingWorkOwned,
} from "./internal/whatsapp-turn";
import {
  contextualInsightQuery,
  expireInsightChannelEvidence as expireInsightChannelEvidenceOwned,
  findInsightDeliveryUser as findInsightDeliveryUserOwned,
  findInsightRecipient as findInsightRecipientOwned,
  insightVerifiedDeliveryQuery as insightVerifiedDeliveryQueryOwned,
  insightVerifiedTranscriptQuery as insightVerifiedTranscriptQueryOwned,
  prepareInsightRecipient as prepareInsightRecipientOwned,
  readInsightDeliveryEvidence as readInsightDeliveryEvidenceOwned,
  reconcileInsightStatus as reconcileInsightStatusOwned,
  recordInsightSend as recordInsightSendOwned,
  stageInsightDelivery as stageInsightDeliveryOwned,
  startInsightSend as startInsightSendOwned,
  sweepInsightChannelEvidence as sweepInsightEvidence,
  weeklySummaryReplyQuery as weeklyReply,
} from "./internal/insight-delivery";

/** Freeze complete content and recipient under live category/processing purpose and the owner's report guard. */
export const stageProactivityMessage: typeof proactivity.stage = (input) =>
  proactivity.stage(input);
/** Atomic one-shot claim; started sends never become eligible for another provider attempt. */
export const startProactivitySend: typeof proactivity.start = (input) => proactivity.start(input);
/** Provider acceptance retains correlation only, never verified delivery. */
export const recordProactivitySend: typeof proactivity.recordSend = (input) =>
  proactivity.recordSend(input);
/** Authenticate ingress before calling; same-User/channel/started-send correlation is rechecked here. */
export const reconcileProactivityStatus: typeof proactivity.reconcile = (input) =>
  proactivity.reconcile(input);
/** Metadata-only routing cannot authorize report content or a provider send. */
export const findProactivityDeliveryUser: typeof proactivity.findDeliveryUser = (input) =>
  proactivity.findDeliveryUser(input);
/** Inert authenticated delivery metadata for atomic Insights/Agent settlement. */
export const proactivityVerifiedDeliveryQuery: typeof proactivity.deliveryQuery = (input) =>
  proactivity.deliveryQuery(input);
/** Exact channel text within fixed retention; Agent separately guards current processing purpose before copying. */
export const proactivityVerifiedTranscriptQuery: typeof proactivity.transcriptQuery = (input) =>
  proactivity.transcriptQuery(input);
/** Bounded independent content erasure preserves one-shot correlation tombstones. */
export const sweepProactivityChannelEvidence: typeof proactivity.sweepEvidence = (input) =>
  proactivity.sweepEvidence(input);

/** Independent bounded deletion of expired channel content, including Users without a Hosted Session. */
export const sweepInsightChannelEvidence = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, WhatsAppUnavailable> =>
  sweepInsightEvidence(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

/** Same-User, same-association proof of a contextual reply to a verified category delivery. */
export const weeklySummaryReplyQuery: typeof weeklyReply = (input) => weeklyReply(input);

/** Stage the exact approved disclosure under same-User intent and current association. */
export const stageWeeklyQuestion: typeof stageQuestion = (input) => stageQuestion(input);
/** Claim once, with current purpose, association and the product delivery window. */
export const startWeeklyQuestion: typeof startQuestion = (input) => startQuestion(input);
/** Acceptance is not delivery; a started question never has a blind resend path. */
export const recordWeeklyQuestionSend: typeof recordQuestion = (input) => recordQuestion(input);
/** Signed correlation routing hint only, rechecked by the User coordinator. */
export const findWeeklyQuestionUser: typeof findQuestionUser = (input) => findQuestionUser(input);
/** Reconcile actual signed delivery; no counter or Consent decision is invented. */
export const reconcileWeeklyQuestion: typeof reconcileQuestion = (input) =>
  reconcileQuestion(input);
/** Metadata proof only; questions never become counted scheduled messages. */
export const weeklyQuestionDeliveryQuery: typeof questionDeliveryQuery = (input) =>
  questionDeliveryQuery(input);
/** Literal yes/no is actionable only as an authenticated reply to this User's verified disclosure. */
export const readWeeklyReplyChoice: typeof readReplyChoice = (input) => readReplyChoice(input);

/** Independently delete expired exact prompt content while preserving no-resend identities. */
export const expireWeeklyQuestions: typeof expireQuestions = (input) => expireQuestions(input);

/** Copy complete exact verified channel text under current purpose and retention; published query never authorizes a requested Turn. */
export const insightVerifiedTranscriptQuery: typeof insightVerifiedTranscriptQueryOwned = (input) =>
  insightVerifiedTranscriptQueryOwned(input);
/** Read actual immutable started/verified metadata; text stays protected by current processing Consent and retention. */
export const readInsightDeliveryEvidence = (
  input: Parameters<typeof readInsightDeliveryEvidenceOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof readInsightDeliveryEvidenceOwned>>,
  WhatsAppUnavailable
> => readInsightDeliveryEvidenceOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Expire exact content independently of User interaction, preserving metadata-only no-resend tombstones. */
export const expireInsightChannelEvidence = (
  input: Parameters<typeof expireInsightChannelEvidenceOwned>[0]
): Effect.Effect<void, WhatsAppUnavailable> =>
  expireInsightChannelEvidenceOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

/** Persist routing only in the authenticated inbound owner's atomic association-qualified unit. */
export const prepareInsightRecipient: typeof prepareInsightRecipientOwned = (input) =>
  prepareInsightRecipientOwned(input);
/** Load a channel route under active processing Consent; exact association is rechecked at send initiation. */
export const findInsightRecipient = (
  input: Parameters<typeof findInsightRecipientOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof findInsightRecipientOwned>>,
  WhatsAppUnavailable
> => findInsightRecipientOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Freeze a full approved body without provider I/O under live occurrence and proactive Consent guards. */
export const stageInsightDelivery = (
  input: Parameters<typeof stageInsightDeliveryOwned>[0]
): Effect.Effect<boolean, WhatsAppUnavailable> =>
  stageInsightDeliveryOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Claim provider initiation at most once under current Consent, association and captured temporal policy. */
export const startInsightSend = (
  input: Parameters<typeof startInsightSendOwned>[0]
): Effect.Effect<Effect.Success<ReturnType<typeof startInsightSendOwned>>, WhatsAppUnavailable> =>
  startInsightSendOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Provider acceptance is not verified delivery. Record only the exact already-started claim. */
export const recordInsightSend = (
  input: Parameters<typeof recordInsightSendOwned>[0]
): Effect.Effect<void, WhatsAppUnavailable> =>
  recordInsightSendOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Reconcile authenticated exact correlation, business-phone, message and timestamp evidence without resending. */
export const reconcileInsightStatus = (
  input: Parameters<typeof reconcileInsightStatusOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof reconcileInsightStatusOwned>>,
  WhatsAppUnavailable
> => reconcileInsightStatusOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Scope a contextual reference to one actually delivered same-User message, without reading its report. */
export const contextualProactiveInsightQuery: typeof contextualInsightQuery = (input) =>
  contextualInsightQuery(input);

/** Metadata-only coordination hint; it cannot authorize a User action. */
export const findInsightDeliveryUser = (
  input: Parameters<typeof findInsightDeliveryUserOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof findInsightDeliveryUserOwned>>,
  WhatsAppUnavailable
> => findInsightDeliveryUserOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Compose proof of actual provider delivery with caller-owned lifecycle effects; no text escapes. */
export const insightVerifiedDeliveryQuery: typeof insightVerifiedDeliveryQueryOwned = (input) =>
  insightVerifiedDeliveryQueryOwned(input);

/** Resolve signed correlation and business-phone evidence to a coordination hint; the exact User attempt must still be rechecked. */
export const findWhatsAppDeliveryUser = (
  input: Parameters<typeof findWhatsAppDeliveryUserOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof findWhatsAppDeliveryUserOwned>>,
  WhatsAppUnavailable
> => findWhatsAppDeliveryUserOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Check the verified conversation window for one User and Turn; an open window grants no authority. */
export const isWhatsAppWindowOpen = (
  input: Parameters<typeof isWhatsAppWindowOpenOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof isWhatsAppWindowOpenOwned>>,
  WhatsAppUnavailable
> => isWhatsAppWindowOpenOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Classify exact provider-message replay without revealing another User’s prior content. */
export const findWhatsAppReplay = (
  input: Parameters<typeof findWhatsAppReplayOwned>[0]
): Effect.Effect<Effect.Success<ReturnType<typeof findWhatsAppReplayOwned>>, WhatsAppUnavailable> =>
  findWhatsAppReplayOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Refuse stale or conflicting inbound evidence before admitting another hosted Turn. */
export const classifyWhatsAppAdmission = (
  input: Parameters<typeof classifyWhatsAppAdmissionOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof classifyWhatsAppAdmissionOwned>>,
  WhatsAppUnavailable
> => classifyWhatsAppAdmissionOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Read only the exact User’s Pending continuation and current association; recheck authority before model execution. */
export const readWhatsAppPendingWork = (
  input: Parameters<typeof readWhatsAppPendingWorkOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof readWhatsAppPendingWorkOwned>>,
  WhatsAppUnavailable
> => readWhatsAppPendingWorkOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Reserve one bounded reply for the User’s Pending Turn before any irreversible provider call. */
export const stageWhatsAppDelivery = (
  input: Parameters<typeof stageWhatsAppDeliveryOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof stageWhatsAppDeliveryOwned>>,
  WhatsAppUnavailable
> => stageWhatsAppDeliveryOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Claim the irreversible send once, only while the same User association and verified window remain current. */
export const startWhatsAppSend = (
  input: Parameters<typeof startWhatsAppSendOwned>[0]
): Effect.Effect<Effect.Success<ReturnType<typeof startWhatsAppSendOwned>>, WhatsAppUnavailable> =>
  startWhatsAppSendOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Refuse a staged reply only before its irreversible send claim; a begun send must reconcile instead. */
export const rejectUnstartedWhatsAppDelivery = (
  input: Parameters<typeof rejectUnstartedWhatsAppDeliveryOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof rejectUnstartedWhatsAppDeliveryOwned>>,
  WhatsAppUnavailable
> =>
  rejectUnstartedWhatsAppDeliveryOwned(input).pipe(
    Effect.mapError(() => new WhatsAppUnavailable())
  );
/** Record one claimed attempt’s bounded provider result; acceptance and ambiguity never mean visible delivery. */
export const recordWhatsAppSend = (
  input: Parameters<typeof recordWhatsAppSendOwned>[0]
): Effect.Effect<Effect.Success<ReturnType<typeof recordWhatsAppSendOwned>>, WhatsAppUnavailable> =>
  recordWhatsAppSendOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Accept only previously authenticated status for the exact User’s correlated attempt, with no effects on mismatch. */
export const recordWhatsAppStatus = (
  input: Parameters<typeof recordWhatsAppStatusOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof recordWhatsAppStatusOwned>>,
  WhatsAppUnavailable
> => recordWhatsAppStatusOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Record authenticated status and return inert terminal evidence; only Agent may commit its Turn with live delivery guards. */
export const reconcileWhatsAppStatus = (
  input: Parameters<typeof reconcileWhatsAppStatusOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof reconcileWhatsAppStatusOwned>>,
  WhatsAppUnavailable
> => reconcileWhatsAppStatusOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Recover abandoned delivery without resending and return inert completion evidence for Agent; preserve unconfirmed outcomes after any possible send. */
export const recoverWhatsAppDelivery = (
  input: Parameters<typeof recoverWhatsAppDeliveryOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof recoverWhatsAppDeliveryOwned>>,
  WhatsAppUnavailable
> => recoverWhatsAppDeliveryOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Compose inbound identity, replay and conversation-window evidence with the caller’s exact User entry and Pending Turn. */
export const prepareWhatsAppInbound: typeof prepareWhatsAppInboundOwned = (input) =>
  prepareWhatsAppInboundOwned(input);
/** Expire only this User’s terminal channel evidence after thirty days; Pending Turn evidence remains protected. */
export const expireWhatsAppEvidence = (
  input: Parameters<typeof expireWhatsAppEvidenceOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof expireWhatsAppEvidenceOwned>>,
  WhatsAppUnavailable
> => expireWhatsAppEvidenceOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Require that the enclosing hosted_turns row has no begun channel send before recording Interrupted. */
export const whatsAppInterruptionGuard: typeof whatsAppInterruptionGuardOwned = () =>
  whatsAppInterruptionGuardOwned();
/** Require verified channel delivery when the enclosing hosted_turns row is completed in its atomic Transcript unit. */
export const whatsAppCompletionGuard: typeof whatsAppCompletionGuardOwned = (input) =>
  whatsAppCompletionGuardOwned(input);
/** Project same-User proposal times for recovery; these timestamps cannot authorize delivery or complete a Turn. */
export const whatsAppProposalTimes: typeof whatsAppProposalTimesOwned = (input) =>
  whatsAppProposalTimesOwned(input);
/** Compose removal of one queued identity in the caller’s terminal or pre-send interruption unit. */
export const prepareWhatsAppWorkCleanup: typeof prepareWhatsAppWorkCleanupOwned = (input) =>
  prepareWhatsAppWorkCleanupOwned(input);

/** Expire metadata-only voice refusal evidence under its fixed seven-day policy. */
export const expireVoiceRefusals = (
  input: Parameters<typeof expireRefusals>[0]
): Effect.Effect<Effect.Success<ReturnType<typeof expireRefusals>>, WhatsAppUnavailable> =>
  expireRefusals(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

/** Observe bounded pending delivery, failed sends and overdue channel cleanup without personal evidence. */
export const inspectWhatsApp: typeof inspect = (input) => inspect(input);

/** Prioritize a due hosted_turns alias t by its retained channel work age within the caller’s bounded recovery query. */
export const whatsAppRecoveryPriority = (): string => recoveryPriority();
