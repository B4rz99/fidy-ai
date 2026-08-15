import { Option, Result, Schema } from "effect";
import type {
  RecordingClient,
  RecordingTransportOutcome,
} from "~/shell/observability/sentry-adapter";

let compatibilityRecorder = Option.none<RecordingClient>();

export const compatibilityConditionNames = [
  "runtimePinned",
  "onePreloadedClient",
  "oneRootPerRequest",
  "boundedRootName",
  "trustedContextContinued",
  "safeRootsStarted",
  "concurrentScopesIsolated",
  "oneDatabaseSpan",
  "databaseMetadataSafe",
  "typedOutcomeIgnored",
  "defectCapturedOnce",
  "atMostOneProviderSpan",
  "providerPropagationAbsent",
  "envelopesProjected",
  "applicationOutcome",
  "sdkPinned",
] as const;

export const CompatibilityReport = Schema.Struct({
  runtimePinned: Schema.Boolean,
  onePreloadedClient: Schema.Boolean,
  oneRootPerRequest: Schema.Boolean,
  boundedRootName: Schema.Boolean,
  trustedContextContinued: Schema.Boolean,
  safeRootsStarted: Schema.Boolean,
  concurrentScopesIsolated: Schema.Boolean,
  oneDatabaseSpan: Schema.Boolean,
  databaseMetadataSafe: Schema.Boolean,
  typedOutcomeIgnored: Schema.Boolean,
  defectCapturedOnce: Schema.Boolean,
  atMostOneProviderSpan: Schema.Boolean,
  providerPropagationAbsent: Schema.Boolean,
  envelopesProjected: Schema.Boolean,
  applicationOutcome: Schema.Boolean,
  sdkPinned: Schema.Boolean,
  elapsedMilliseconds: Schema.Finite,
});

export type CompatibilityReport = typeof CompatibilityReport.Type;
export type CompatibilityTransportOutcome = RecordingTransportOutcome;

/** Installs the fixture recorder once so the preloaded client is the client exercised by the body. */
export const installCompatibilityRecorder = (recorder: RecordingClient): void => {
  if (Option.isSome(compatibilityRecorder)) throw new Error("compatibility recorder replaced");
  compatibilityRecorder = Option.some(recorder);
};

/** Reads the recorder created before the compatibility fixture body was imported. */
export const getCompatibilityRecorder = (): RecordingClient =>
  Option.getOrThrowWith(compatibilityRecorder, () => new Error("compatibility preload missing"));

/** Converts a Result into a preload failure without introducing a fallback initialization path. */
export const requireInstalled = <A, E>(result: Result.Result<A, E>): A =>
  Result.match(result, {
    onFailure: (error) => {
      throw new Error("compatibility preload handoff failed", { cause: error });
    },
    onSuccess: (value) => value,
  });
