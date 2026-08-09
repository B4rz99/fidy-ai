import { Function as Fn, Result, Schema } from "effect";
import type {
  RecordingClient,
  RecordingTransportOutcome,
} from "~/shell/observability/sentry-adapter";

const compatibilityKey = Symbol.for("fidy-ai/testing/observability-compatibility");

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
  if (Reflect.has(globalThis, compatibilityKey)) throw new Error("compatibility recorder replaced");
  Reflect.set(globalThis, compatibilityKey, recorder);
};

/** Reads the recorder created before the compatibility fixture body was imported. */
export const getCompatibilityRecorder = (): RecordingClient => {
  const globals = Fn.cast<unknown, Readonly<Record<PropertyKey, unknown>>>(globalThis);
  const recorder = globals[compatibilityKey];
  if (recorder === undefined) throw new Error("compatibility preload missing");
  return Fn.cast<unknown, RecordingClient>(recorder);
};

/** Converts a Result into a preload failure without introducing a fallback initialization path. */
export const requireInstalled = <A, E>(result: Result.Result<A, E>): A =>
  Result.match(result, {
    onFailure: (error) => {
      throw new Error("compatibility preload handoff failed", { cause: error });
    },
    onSuccess: (value) => value,
  });
