import { Effect, Option, Schema } from "effect";
import type { SentryVerificationReport } from "./account-policy";
import { type DeploymentSmokeEmission, deploymentSmokeSourceLocation } from "./deployment-smoke";
import type { TelemetryRelease } from "./telemetry-config";

/** Stable rollout checks safe to include in command output and CI logs. */
export const DeploymentSmokeCheck = Schema.Literals([
  "account",
  "flush",
  "single-issue",
  "symbolication",
  "trace-causality",
  "projected-fields",
  "sentinel-absence",
  "expected-outcome-silence",
  "provider-header-isolation",
  "operator-url",
]);
export type DeploymentSmokeCheck = typeof DeploymentSmokeCheck.Type;

/** Metadata-only rollout failure. No provider payload, locator, URL, or credential is retained. */
export class DeploymentSmokeGateError extends Schema.TaggedErrorClass<DeploymentSmokeGateError>()(
  "DeploymentSmokeGateError",
  {
    check: DeploymentSmokeCheck,
    reason: Schema.Literals(["invalid-config", "unavailable", "timed-out", "mismatch"]),
  }
) {}

/** Closed operation vocabulary accepted in the projected deployment-smoke trace. */
export const SentryDeploymentSmokeTraceOperation = Schema.Literals([
  "http.server",
  "queue.publish",
  "queue.process",
  "agent.turn",
  "agent.model",
  "http.client",
  "fidy.operation",
]);
export type SentryDeploymentSmokeTraceOperation = typeof SentryDeploymentSmokeTraceOperation.Type;

/** Minimal recursive trace view projected from Sentry's trace response. */
export type SentryDeploymentSmokeTraceNode = Readonly<{
  name: string;
  op: SentryDeploymentSmokeTraceOperation;
  children: ReadonlyArray<SentryDeploymentSmokeTraceNode>;
}>;

/** Bounded, secret-free observation returned by the authenticated Sentry reader. */
export type SentryDeploymentSmokeObservation = Readonly<{
  flushCompleted: boolean;
  issueCount: number;
  eventCount: number;
  release: string;
  traceId: string;
  defect: Readonly<{
    component: string;
    operation: string;
    error: string;
    exceptionType: string;
    exceptionValue: string;
    source: Readonly<{ module: string; file: string; function: string; line: number }>;
  }>;
  trace: SentryDeploymentSmokeTraceNode;
  expectedOutcomeIssueCount: number;
  projectedFieldsOnly: boolean;
  sentinelsAbsent: boolean;
}>;

type DeploymentSmokeGateInput = Readonly<{
  release: TelemetryRelease;
  emission: DeploymentSmokeEmission;
  account: SentryVerificationReport;
  observation: SentryDeploymentSmokeObservation;
  operatorUrlTemplate: Option.Option<string>;
}>;

/** The only successful deployment-gate output. */
export type DeploymentSmokeReport = Readonly<{
  version: 1;
  release: TelemetryRelease;
  traceId: DeploymentSmokeEmission["traceId"];
  operatorUrl: Option.Option<URL>;
  checks: ReadonlyArray<DeploymentSmokeCheck>;
}>;

const expectedTrace: SentryDeploymentSmokeTraceNode = {
  name: "POST /deployment-smoke",
  op: "http.server",
  children: [
    {
      name: "observability.deploymentSmokePublish",
      op: "queue.publish",
      children: [
        {
          name: "observability.deploymentSmokeProcess",
          op: "queue.process",
          children: [
            {
              name: "observability.deploymentSmokeAgent",
              op: "agent.turn",
              children: [
                {
                  name: "observability.deploymentSmokeModel",
                  op: "agent.model",
                  children: [
                    {
                      name: "observability.deploymentSmokeProvider",
                      op: "http.client",
                      children: [],
                    },
                  ],
                },
              ],
            },
            {
              name: "observability.deploymentSmokeExpectedOutcome",
              op: "fidy.operation",
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

const traceMatches = (
  actual: SentryDeploymentSmokeTraceNode,
  expected: SentryDeploymentSmokeTraceNode
): boolean =>
  actual.name === expected.name &&
  actual.op === expected.op &&
  actual.children.length === expected.children.length &&
  actual.children.every((child, index) => {
    const expectedChild = expected.children[index];
    return expectedChild !== undefined && traceMatches(child, expectedChild);
  });

const fail = (
  check: DeploymentSmokeCheck,
  reason: DeploymentSmokeGateError["reason"] = "mismatch"
): Effect.Effect<never, DeploymentSmokeGateError> =>
  Effect.fail(DeploymentSmokeGateError.make({ check, reason }));

const verify = (
  matches: boolean,
  check: DeploymentSmokeCheck,
  reason?: DeploymentSmokeGateError["reason"]
): Effect.Effect<void, DeploymentSmokeGateError> => (matches ? Effect.void : fail(check, reason));

const sourceMatches = (observation: SentryDeploymentSmokeObservation): boolean => {
  const source = observation.defect.source;
  return [
    source.module === deploymentSmokeSourceLocation.module,
    source.file === deploymentSmokeSourceLocation.file,
    source.function === deploymentSmokeSourceLocation.function,
    source.line === deploymentSmokeSourceLocation.line,
  ].every(Boolean);
};

const defectMatches = (input: DeploymentSmokeGateInput): boolean =>
  [
    input.observation.release === input.release,
    input.observation.traceId === input.emission.traceId,
    input.observation.defect.component === "ci",
    input.observation.defect.operation === "observability.deploymentSmokeDefect",
    input.observation.defect.error === "deployment_smoke_defect",
    input.observation.defect.exceptionType === "FidyDefect",
    input.observation.defect.exceptionValue === "Unexpected defect",
    sourceMatches(input.observation),
  ].every(Boolean);

const validateOperatorUrl = (
  template: Option.Option<string>,
  traceId: string
): Effect.Effect<Option.Option<URL>, DeploymentSmokeGateError> =>
  Option.match(template, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (candidate) => {
      const slots = candidate.split("{traceId}").length - 1;
      if (slots !== 1) return fail("operator-url", "invalid-config");
      return Schema.decodeUnknownEffect(Schema.URLFromString)(
        candidate.replace("{traceId}", traceId)
      ).pipe(
        Effect.mapError(() =>
          DeploymentSmokeGateError.make({ check: "operator-url", reason: "invalid-config" })
        ),
        Effect.filterOrFail(
          (url) =>
            url.protocol === "https:" &&
            url.username.length === 0 &&
            url.password.length === 0 &&
            url.hash.length === 0,
          () => DeploymentSmokeGateError.make({ check: "operator-url", reason: "invalid-config" })
        ),
        Effect.map(Option.some)
      );
    },
  });

const expectedChecks: ReadonlyArray<DeploymentSmokeCheck> = DeploymentSmokeCheck.literals;
const validationTraceId = "00000000000000000000000000000000";

/** Validates optional operator discoverability before the one-shot smoke emits anything. */
export const validateDeploymentSmokeOperatorUrlTemplate = (
  template: Option.Option<string>
): Effect.Effect<void, DeploymentSmokeGateError> =>
  validateOperatorUrl(template, validationTraceId).pipe(Effect.asVoid);

const DeploymentSmokeReportJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    release: Schema.String,
    traceId: Schema.String,
    operatorUrl: Schema.OptionFromNullOr(Schema.String),
    checks: Schema.Array(DeploymentSmokeCheck),
  })
);

/** Serializes only the closed secret-free report shape. */
export const renderDeploymentSmokeReport = (report: DeploymentSmokeReport): string =>
  Schema.encodeUnknownSync(DeploymentSmokeReportJson)({
    ...report,
    operatorUrl: Option.map(report.operatorUrl, (url) => url.href),
  });

/** Compares projected live-project evidence and returns no partial success. */
export const evaluateDeploymentSmoke = (
  input: DeploymentSmokeGateInput
): Effect.Effect<DeploymentSmokeReport, DeploymentSmokeGateError> =>
  Effect.gen(function* () {
    yield* verify(input.account.overall === "verified", "account");
    yield* verify(input.observation.flushCompleted, "flush", "timed-out");
    yield* verify(
      input.observation.issueCount === 1 && input.observation.eventCount === 1,
      "single-issue"
    );
    yield* verify(defectMatches(input), "symbolication");
    yield* verify(traceMatches(input.observation.trace, expectedTrace), "trace-causality");
    yield* verify(input.observation.projectedFieldsOnly, "projected-fields");
    yield* verify(input.observation.sentinelsAbsent, "sentinel-absence");
    yield* verify(input.observation.expectedOutcomeIssueCount === 0, "expected-outcome-silence");
    yield* verify(input.emission.providerHeadersAreIsolated, "provider-header-isolation");
    const operatorUrl = yield* validateOperatorUrl(
      input.operatorUrlTemplate,
      input.emission.traceId
    );
    return {
      version: 1,
      release: input.release,
      traceId: input.emission.traceId,
      operatorUrl,
      checks: expectedChecks,
    };
  });
