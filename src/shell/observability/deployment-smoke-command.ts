import { Config, Console, Effect, Option, Schedule } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { type SentryVerificationReport, verifySentryAccount } from "./account-policy";
import {
  type DeploymentSmokeEmission,
  type DeploymentSmokeFlowError,
  deploymentSmokeEnvelopesAreSafe,
  runDeploymentSmokeFlow,
} from "./deployment-smoke";
import {
  DeploymentSmokeGateError,
  evaluateDeploymentSmoke,
  renderDeploymentSmokeReport,
  validateDeploymentSmokeOperatorUrlTemplate,
} from "./deployment-smoke-gate";
import {
  type SentryEvidenceReadError,
  readSentryOperatorEvidence,
} from "./sentry-account-evidence";
import { inspectSentryAccount, unavailableSentryAccountObservation } from "./sentry-account-reader";
import { makeSentryRecordingClient, makeSentryTelemetry } from "./sentry-adapter";
import { inspectDeploymentSmoke } from "./sentry-smoke-reader";
import {
  type DeploymentSmokeTelemetryConfig,
  decodeSentryDeploymentSmokeConfig,
} from "./telemetry-config";
import { makeTelemetryService } from "./telemetry";

const commandConfig = Config.all({
  dsn: Config.redacted("SENTRY_DEPLOYMENT_SMOKE_DSN"),
  release: Config.string("SENTRY_RELEASE"),
  approvedDsnOrigin: Config.string("SENTRY_PRODUCTION_DSN_ORIGIN"),
  approvedDsnProjectId: Config.string("SENTRY_PRODUCTION_DSN_PROJECT_ID"),
  readToken: Config.redacted("SENTRY_SMOKE_READ_TOKEN"),
  organizationSlug: Config.redacted("SENTRY_ORGANIZATION_SLUG"),
  productionProjectSlug: Config.redacted("SENTRY_PRODUCTION_PROJECT_SLUG"),
  nonProductionProjectSlug: Config.redacted("SENTRY_NON_PRODUCTION_PROJECT_SLUG"),
  evidencePath: Config.string("SENTRY_OPERATOR_EVIDENCE_PATH"),
  operatorUrlTemplate: Config.option(Config.string("SENTRY_TRACE_URL_TEMPLATE")),
});

const sentryFlushTimeoutMilliseconds = 1_000;
const ingestionPollDelayMilliseconds = 2_000;
const ingestionPollAttempts = 30;

const privacyPreflight = Effect.acquireUseRelease(
  Effect.sync(() => makeSentryRecordingClient()),
  (recording) =>
    Effect.gen(function* () {
      yield* runDeploymentSmokeFlow(makeTelemetryService(recording.adapter));
      const envelopes = yield* recording.serializedEnvelopes;
      if (!deploymentSmokeEnvelopesAreSafe(envelopes)) {
        return yield* DeploymentSmokeGateError.make({
          check: "sentinel-absence",
          reason: "mismatch",
        });
      }
    }),
  (recording) => recording.close
);

const emitAndFlush = (
  config: DeploymentSmokeTelemetryConfig
): Effect.Effect<
  Readonly<{ emission: DeploymentSmokeEmission; flushed: boolean }>,
  DeploymentSmokeFlowError
> =>
  Effect.acquireUseRelease(
    Effect.sync(() => makeSentryTelemetry(config)),
    (telemetry) =>
      Effect.gen(function* () {
        const emission = yield* runDeploymentSmokeFlow(
          makeTelemetryService(telemetry.resource.adapter)
        );
        const flushed = yield* Effect.promise(() =>
          telemetry.client.flush(sentryFlushTimeoutMilliseconds)
        ).pipe(
          Effect.timeoutOption(sentryFlushTimeoutMilliseconds),
          Effect.map(Option.getOrElse(() => false))
        );
        return { emission, flushed };
      }),
    (telemetry) => telemetry.resource.close
  );

type CommandConfig = Effect.Success<typeof commandConfig>;

const readVerifiedAccount = (
  raw: CommandConfig
): Effect.Effect<
  SentryVerificationReport,
  DeploymentSmokeGateError | SentryEvidenceReadError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const evidence = yield* readSentryOperatorEvidence(Bun.file(raw.evidencePath));
    const observation = yield* inspectSentryAccount({
      authToken: raw.readToken,
      organizationSlug: raw.organizationSlug,
      productionProjectSlug: raw.productionProjectSlug,
      nonProductionProjectSlug: raw.nonProductionProjectSlug,
    }).pipe(
      Effect.catchTag("SentryAccountReadError", () =>
        Effect.succeed(unavailableSentryAccountObservation)
      )
    );
    const account = verifySentryAccount({ observation, evidence: Option.some(evidence) });
    return account.overall === "verified"
      ? account
      : yield* DeploymentSmokeGateError.make({ check: "account", reason: "mismatch" });
  });

/** Runs the private post-deployment Sentry rollout gate. */
export const deploymentSmokeCommand = Effect.gen(function* () {
  const raw = yield* commandConfig;
  const telemetryConfig = yield* decodeSentryDeploymentSmokeConfig({
    dsn: raw.dsn,
    release: raw.release,
    approvedOrigin: raw.approvedDsnOrigin,
    approvedProjectId: raw.approvedDsnProjectId,
  });
  const operatorUrlTemplate = Option.filter(
    raw.operatorUrlTemplate,
    (candidate) => candidate.trim().length > 0
  );
  yield* validateDeploymentSmokeOperatorUrlTemplate(operatorUrlTemplate);
  const account = yield* readVerifiedAccount(raw);

  yield* privacyPreflight;
  const emitted = yield* emitAndFlush(telemetryConfig);
  if (!emitted.flushed) {
    return yield* DeploymentSmokeGateError.make({ check: "flush", reason: "timed-out" });
  }
  const observation = yield* inspectDeploymentSmoke({
    config: {
      authToken: raw.readToken,
      organizationSlug: raw.organizationSlug,
      projectSlug: raw.productionProjectSlug,
    },
    release: telemetryConfig.release,
    emission: emitted.emission,
    flushCompleted: emitted.flushed,
  }).pipe(
    Effect.retry({
      while: (error) => error.reason === "not-ingested",
      schedule: Schedule.spaced(ingestionPollDelayMilliseconds),
      times: ingestionPollAttempts,
    }),
    Effect.mapError((error) =>
      DeploymentSmokeGateError.make({
        check: "trace-causality",
        reason: error.reason === "not-ingested" ? "timed-out" : "unavailable",
      })
    )
  );
  const report = yield* evaluateDeploymentSmoke({
    release: telemetryConfig.release,
    emission: emitted.emission,
    account,
    observation,
    operatorUrlTemplate,
  });
  yield* Console.log(renderDeploymentSmokeReport(report));
});
