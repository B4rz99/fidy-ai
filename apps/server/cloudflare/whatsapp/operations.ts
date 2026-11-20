import {
  claimRegisteredSend as claimRegisteredSendOwned,
  recordRegisteredSend as recordRegisteredSendOwned,
} from "./internal/registered-send";
import { makeStatusLookupAdmission as makeStatusLookupAdmissionOwned } from "./internal/status-admission";
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
  submitHostedReply as submitHostedReplyOwned,
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
  findQueuedInsightRecipient as findQueuedInsightRecipientOwned,
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

export const stageProactivityMessage: typeof proactivity.stage = (input) =>
  proactivity.stage(input);

export const startProactivitySend: typeof proactivity.start = (input) => proactivity.start(input);

export const recordProactivitySend: typeof proactivity.recordSend = (input) =>
  proactivity.recordSend(input);

export const prepareProactivityStatus: typeof proactivity.prepareReconciliation = (input) =>
  proactivity.prepareReconciliation(input);
export const reconcileProactivityStatus: typeof proactivity.reconcile = (input) =>
  proactivity.reconcile(input);

export const findProactivityDeliveryUser: typeof proactivity.findDeliveryUser = (input) =>
  proactivity.findDeliveryUser(input);

export const proactivityStartedDeliveryQuery: typeof proactivity.startedDeliveryQuery = () =>
  proactivity.startedDeliveryQuery();

export const proactivityRejectedDeliveryQuery: typeof proactivity.rejectedDeliveryQuery = (input) =>
  proactivity.rejectedDeliveryQuery(input);

export const proactivityVerifiedDeliveryQuery: typeof proactivity.deliveryQuery = (input) =>
  proactivity.deliveryQuery(input);

export const proactivityVerifiedControlQuery: typeof proactivity.controlQuery = (input) =>
  proactivity.controlQuery(input);

export const proactivityVerifiedTranscriptQuery: typeof proactivity.transcriptQuery = (input) =>
  proactivity.transcriptQuery(input);

export const proactivityReminderReplyQuery: typeof proactivity.replyQuery = (input) =>
  proactivity.replyQuery(input);
export const sweepProactivityChannelEvidence: typeof proactivity.sweepEvidence = (input) =>
  proactivity.sweepEvidence(input);

export const sweepInsightChannelEvidence = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, WhatsAppUnavailable> =>
  sweepInsightEvidence(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const weeklySummaryReplyQuery: typeof weeklyReply = (input) => weeklyReply(input);

export const stageWeeklyQuestion: typeof stageQuestion = (input) => stageQuestion(input);

export const startWeeklyQuestion: typeof startQuestion = (input) => startQuestion(input);

export const recordWeeklyQuestionSend: typeof recordQuestion = (input) => recordQuestion(input);

export const findWeeklyQuestionUser: typeof findQuestionUser = (input) => findQuestionUser(input);

export const reconcileWeeklyQuestion: typeof reconcileQuestion = (input) =>
  reconcileQuestion(input);

export const weeklyQuestionDeliveryQuery: typeof questionDeliveryQuery = (input) =>
  questionDeliveryQuery(input);

export const readDisclosureReplyChoice: typeof readReplyChoice = (input) => readReplyChoice(input);

export const expireWeeklyQuestions: typeof expireQuestions = (input) => expireQuestions(input);

export const insightVerifiedTranscriptQuery: typeof insightVerifiedTranscriptQueryOwned = (input) =>
  insightVerifiedTranscriptQueryOwned(input);

export const readInsightDeliveryEvidence = (
  input: Parameters<typeof readInsightDeliveryEvidenceOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof readInsightDeliveryEvidenceOwned>>,
  WhatsAppUnavailable
> => readInsightDeliveryEvidenceOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const expireInsightChannelEvidence = (
  input: Parameters<typeof expireInsightChannelEvidenceOwned>[0]
): Effect.Effect<void, WhatsAppUnavailable> =>
  expireInsightChannelEvidenceOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const prepareInsightRecipient: typeof prepareInsightRecipientOwned = (input) =>
  prepareInsightRecipientOwned(input);

export const findInsightRecipient = (
  input: Parameters<typeof findInsightRecipientOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof findInsightRecipientOwned>>,
  WhatsAppUnavailable
> => findInsightRecipientOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const findQueuedInsightRecipient = (
  input: Parameters<typeof findQueuedInsightRecipientOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof findQueuedInsightRecipientOwned>>,
  WhatsAppUnavailable
> => findQueuedInsightRecipientOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const stageInsightDelivery = (
  input: Parameters<typeof stageInsightDeliveryOwned>[0]
): Effect.Effect<boolean, WhatsAppUnavailable> =>
  stageInsightDeliveryOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const startInsightSend = (
  input: Parameters<typeof startInsightSendOwned>[0]
): Effect.Effect<Effect.Success<ReturnType<typeof startInsightSendOwned>>, WhatsAppUnavailable> =>
  startInsightSendOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const recordInsightSend = (
  input: Parameters<typeof recordInsightSendOwned>[0]
): Effect.Effect<void, WhatsAppUnavailable> =>
  recordInsightSendOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const reconcileInsightStatus = (
  input: Parameters<typeof reconcileInsightStatusOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof reconcileInsightStatusOwned>>,
  WhatsAppUnavailable
> => reconcileInsightStatusOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const contextualProactiveInsightQuery: typeof contextualInsightQuery = (input) =>
  contextualInsightQuery(input);

export const findInsightDeliveryUser = (
  input: Parameters<typeof findInsightDeliveryUserOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof findInsightDeliveryUserOwned>>,
  WhatsAppUnavailable
> => findInsightDeliveryUserOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const insightVerifiedDeliveryQuery: typeof insightVerifiedDeliveryQueryOwned = (input) =>
  insightVerifiedDeliveryQueryOwned(input);

export const findWhatsAppDeliveryUser = (
  input: Parameters<typeof findWhatsAppDeliveryUserOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof findWhatsAppDeliveryUserOwned>>,
  WhatsAppUnavailable
> => findWhatsAppDeliveryUserOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const isWhatsAppWindowOpen = (
  input: Parameters<typeof isWhatsAppWindowOpenOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof isWhatsAppWindowOpenOwned>>,
  WhatsAppUnavailable
> => isWhatsAppWindowOpenOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const findWhatsAppReplay = (
  input: Parameters<typeof findWhatsAppReplayOwned>[0]
): Effect.Effect<Effect.Success<ReturnType<typeof findWhatsAppReplayOwned>>, WhatsAppUnavailable> =>
  findWhatsAppReplayOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const classifyWhatsAppAdmission = (
  input: Parameters<typeof classifyWhatsAppAdmissionOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof classifyWhatsAppAdmissionOwned>>,
  WhatsAppUnavailable
> => classifyWhatsAppAdmissionOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const readWhatsAppPendingWork = (
  input: Parameters<typeof readWhatsAppPendingWorkOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof readWhatsAppPendingWorkOwned>>,
  WhatsAppUnavailable
> => readWhatsAppPendingWorkOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const stageWhatsAppDelivery = (
  input: Parameters<typeof stageWhatsAppDeliveryOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof stageWhatsAppDeliveryOwned>>,
  WhatsAppUnavailable
> => stageWhatsAppDeliveryOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const startWhatsAppSend = (
  input: Parameters<typeof startWhatsAppSendOwned>[0]
): Effect.Effect<Effect.Success<ReturnType<typeof startWhatsAppSendOwned>>, WhatsAppUnavailable> =>
  startWhatsAppSendOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const rejectUnstartedWhatsAppDelivery = (
  input: Parameters<typeof rejectUnstartedWhatsAppDeliveryOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof rejectUnstartedWhatsAppDeliveryOwned>>,
  WhatsAppUnavailable
> =>
  rejectUnstartedWhatsAppDeliveryOwned(input).pipe(
    Effect.mapError(() => new WhatsAppUnavailable())
  );

export const recordWhatsAppSend = (
  input: Parameters<typeof recordWhatsAppSendOwned>[0]
): Effect.Effect<Effect.Success<ReturnType<typeof recordWhatsAppSendOwned>>, WhatsAppUnavailable> =>
  recordWhatsAppSendOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const recordWhatsAppStatus = (
  input: Parameters<typeof recordWhatsAppStatusOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof recordWhatsAppStatusOwned>>,
  WhatsAppUnavailable
> => recordWhatsAppStatusOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const reconcileWhatsAppStatus = (
  input: Parameters<typeof reconcileWhatsAppStatusOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof reconcileWhatsAppStatusOwned>>,
  WhatsAppUnavailable
> => reconcileWhatsAppStatusOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const recoverWhatsAppDelivery = (
  input: Parameters<typeof recoverWhatsAppDeliveryOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof recoverWhatsAppDeliveryOwned>>,
  WhatsAppUnavailable
> => recoverWhatsAppDeliveryOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const prepareWhatsAppInbound: typeof prepareWhatsAppInboundOwned = (input) =>
  prepareWhatsAppInboundOwned(input);

export const expireWhatsAppEvidence = (
  input: Parameters<typeof expireWhatsAppEvidenceOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof expireWhatsAppEvidenceOwned>>,
  WhatsAppUnavailable
> => expireWhatsAppEvidenceOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const whatsAppInterruptionGuard: typeof whatsAppInterruptionGuardOwned = () =>
  whatsAppInterruptionGuardOwned();

export const whatsAppCompletionGuard: typeof whatsAppCompletionGuardOwned = (input) =>
  whatsAppCompletionGuardOwned(input);

export const whatsAppProposalTimes: typeof whatsAppProposalTimesOwned = (input) =>
  whatsAppProposalTimesOwned(input);

export const prepareWhatsAppWorkCleanup: typeof prepareWhatsAppWorkCleanupOwned = (input) =>
  prepareWhatsAppWorkCleanupOwned(input);

export const expireVoiceRefusals = (
  input: Parameters<typeof expireRefusals>[0]
): Effect.Effect<Effect.Success<ReturnType<typeof expireRefusals>>, WhatsAppUnavailable> =>
  expireRefusals(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const inspectWhatsApp: typeof inspect = (input) => inspect(input);

export const whatsAppRecoveryPriority = (): string => recoveryPriority();

export const admitStatusLookup = (
  input: Readonly<{
    database: D1Database;
    request: Parameters<ReturnType<typeof makeStatusLookupAdmissionOwned>>[0];
  }>
): ReturnType<ReturnType<typeof makeStatusLookupAdmissionOwned>> =>
  makeStatusLookupAdmissionOwned(input.database)(input.request);

export const submitHostedReply = (
  input: Parameters<typeof submitHostedReplyOwned>[0]
): Effect.Effect<Effect.Success<ReturnType<typeof submitHostedReplyOwned>>, WhatsAppUnavailable> =>
  submitHostedReplyOwned(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const claimRegisteredSend: typeof claimRegisteredSendOwned = (...args) =>
  claimRegisteredSendOwned(...args);
export const recordRegisteredSend: typeof recordRegisteredSendOwned = (...args) =>
  recordRegisteredSendOwned(...args);
