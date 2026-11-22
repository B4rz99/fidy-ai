import { nativePendingWork } from "./internal/native-work-observation";
import {
  acknowledgePauseNotice,
  bindPauseNotice,
  includePauseNotice,
} from "./internal/native-pause-notice";
import { readLocalReport } from "./internal/recurring-report";
import { claimDisclosure, retainedDisclosure } from "./internal/local-disclosure";
import { claimPurpose, reconcileReceipt } from "./internal/reminder-claim";
import {
  pendingInsights,
  prepareSchedule,
  prepareTransition,
  readSchedule,
} from "./internal/local-insights";

import { Effect, Option } from "effect";
import { InsightUnavailable, type PauseNoticeService } from "./contract";
import { weeklyReportDeliveryQuery as weeklyReportDeliveryQueryOwned } from "./internal/weekly-generation";

export const weeklyReportDeliveryQuery: typeof weeklyReportDeliveryQueryOwned = (input) =>
  weeklyReportDeliveryQueryOwned(input);

export const prepareLocalInsight: typeof prepareTransition = (...input) =>
  prepareTransition(...input);

export const prepareLocalReminder: typeof prepareSchedule = (...input) => prepareSchedule(...input);

export const readLocalReminder: typeof readSchedule = (user) => readSchedule(user);

export const claimLocalReminderPurpose: typeof claimPurpose = (...args) => claimPurpose(...args);

export const reconcileLocalReminder: typeof reconcileReceipt = (...args) =>
  reconcileReceipt(...args);

export const claimLocalDisclosure: typeof claimDisclosure = (...args) => claimDisclosure(...args);

export const isRetainedDisclosure: typeof retainedDisclosure = (...args) =>
  retainedDisclosure(...args);

export const readLocalPendingInsights: typeof pendingInsights = (...args) =>
  pendingInsights(...args);

export const readLocalDigestReport: typeof readLocalReport = (input) => readLocalReport(input);

export const nativePauseNotice: PauseNoticeService = {
  bind: (...args: Parameters<typeof bindPauseNotice>) =>
    bindPauseNotice(...args).pipe(
      Effect.mapError((cause) => new InsightUnavailable({ cause: Option.some(cause) }))
    ),
  include: (...args: Parameters<typeof includePauseNotice>) =>
    includePauseNotice(...args).pipe(
      Effect.mapError((cause) => new InsightUnavailable({ cause: Option.some(cause) }))
    ),
  acknowledge: (...args: Parameters<typeof acknowledgePauseNotice>) =>
    acknowledgePauseNotice(...args).pipe(
      Effect.mapError((cause) => new InsightUnavailable({ cause: Option.some(cause) }))
    ),
};

export const localProactivityObservations: typeof nativePendingWork = (flags) =>
  nativePendingWork(flags);
