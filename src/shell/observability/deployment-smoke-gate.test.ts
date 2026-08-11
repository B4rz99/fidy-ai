import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import type { SentryVerificationReport } from "./account-policy";
import { type DeploymentSmokeEmission, deploymentSmokeSourceLocation } from "./deployment-smoke";
import {
  type SentryDeploymentSmokeObservation,
  evaluateDeploymentSmoke,
  renderDeploymentSmokeReport,
} from "./deployment-smoke-gate";
import { TelemetryTraceId } from "./protocol";
import type { TelemetryRelease } from "./telemetry-config";

const release: TelemetryRelease = "fidy@0123456789abcdef0123456789abcdef01234567";
const traceId = TelemetryTraceId.make("0123456789abcdef0123456789abcdef");
const emission: DeploymentSmokeEmission = {
  traceId,
  publicationContext: Option.none(),
  providerHeadersAreIsolated: true,
};
const verifiedAccount: SentryVerificationReport = {
  policyRevision: 2,
  overall: "verified",
  findings: [],
  quotaResponseActions: [],
};

const node = (
  name: string,
  op: SentryDeploymentSmokeObservation["trace"]["op"],
  children: ReadonlyArray<SentryDeploymentSmokeObservation["trace"]> = []
): SentryDeploymentSmokeObservation["trace"] => ({ name, op, children });

const observation: SentryDeploymentSmokeObservation = {
  flushCompleted: true,
  issueCount: 1,
  eventCount: 1,
  release,
  traceId,
  defect: {
    component: "ci",
    operation: "observability.deploymentSmokeDefect",
    error: "deployment_smoke_defect",
    exceptionType: "FidyDefect",
    exceptionValue: "Unexpected defect",
    source: deploymentSmokeSourceLocation,
  },
  trace: node("POST /deployment-smoke", "http.server", [
    node("observability.deploymentSmokePublish", "queue.publish", [
      node("observability.deploymentSmokeProcess", "queue.process", [
        node("observability.deploymentSmokeAgent", "agent.turn", [
          node("observability.deploymentSmokeModel", "agent.model", [
            node("observability.deploymentSmokeProvider", "http.client"),
          ]),
        ]),
        node("observability.deploymentSmokeExpectedOutcome", "fidy.operation"),
      ]),
    ]),
  ]),
  expectedOutcomeIssueCount: 0,
  projectedFieldsOnly: true,
  sentinelsAbsent: true,
};

it.effect(
  "returns only a stable trace ID and a validated optional operator URL after every gate passes",
  () =>
    Effect.gen(function* () {
      const report = yield* evaluateDeploymentSmoke({
        release,
        emission,
        account: verifiedAccount,
        observation,
        operatorUrlTemplate: Option.some("https://sentry.io/organizations/fidy/traces/{traceId}"),
      });

      expect(report.release).toBe(release);
      expect(report.traceId).toBe(traceId);
      expect(Option.getOrNull(report.operatorUrl)?.href).toBe(
        `https://sentry.io/organizations/fidy/traces/${traceId}`
      );
      expect(renderDeploymentSmokeReport(report)).toContain(
        `https://sentry.io/organizations/fidy/traces/${traceId}`
      );
      expect(renderDeploymentSmokeReport(report)).not.toContain("token");
      expect(report.checks).toEqual([
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
    })
);

it.effect("fails with fixed metadata when retrieved privacy or causality evidence mismatches", () =>
  Effect.gen(function* () {
    const exit = yield* evaluateDeploymentSmoke({
      release,
      emission,
      account: verifiedAccount,
      observation: {
        ...observation,
        sentinelsAbsent: false,
        trace: node("POST /deployment-smoke", "http.server"),
      },
      operatorUrlTemplate: Option.none(),
    }).pipe(Effect.exit);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0];
      expect(reason).toBeDefined();
      if (reason !== undefined && Cause.isFailReason(reason)) {
        expect(reason.error).toMatchObject({
          check: "trace-causality",
          reason: "mismatch",
        });
      }
      expect(String(exit.cause)).not.toContain("deployment-smoke-http-sentinel");
    }
  })
);
