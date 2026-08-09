import { expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import {
  type SentryAccountObservation,
  SentryOperatorEvidence,
  type SentryProjectObservation,
  SentryScrubField,
  SentryVerificationReport,
  renderSentryVerificationReport,
  verifySentryAccount,
} from "./account-policy";

const scrubbedFields = SentryScrubField.literals;

const makeEvidence = (
  configuration: Partial<SentryOperatorEvidence["configuration"]> = {}
): SentryOperatorEvidence =>
  SentryOperatorEvidence.make({
    version: 1,
    observedAt: "2026-08-04T12:00:00Z",
    account: {
      plan: "developer",
      isTrial: false,
      isLegacy: false,
      errorQuota: 5_000,
      spanQuota: 5_000_000,
      quotaResetAt: "2026-09-01T00:00:00Z",
      retentionDays: 30,
      maximumMembers: 1,
      storageRegion: "us",
    },
    compliance: {
      processingTermsReviewed: true,
      processingTermsEffectiveDate: "2025-01-01",
      subprocessorsReviewed: true,
      subprocessorListCheckedAt: "2026-08-04T12:00:00Z",
      regionOnlyProcessingClaimed: false,
    },
    configuration: {
      productionSpikeProtectionDisabled: true,
      productionHardQuotaDropsAccepted: true,
      productionScrubbedFields: [...scrubbedFields],
      nonProductionScrubbedFields: [...scrubbedFields],
      verifiedOperatorRecipientCount: 1,
      productionAlerts: {
        newRegressedDefectImmediate: true,
        operationalFailureErrorCode: "operational_failure",
        operationalFailureOccurrences: 5,
        operationalFailureWindowMinutes: 10,
        apiSpanOperation: "http.server",
        apiP95Seconds: 2,
        apiP95WindowMinutes: 15,
        queueDelayField: "fidy.delay_milliseconds",
        queueP95Milliseconds: 60_000,
        queueP95WindowMinutes: 15,
        quotaUsagePercentages: [50, 75, 90],
        productionProjectOnly: true,
        productionEnvironmentOnly: true,
        verifiedOperatorRecipientOnly: true,
      },
      localAlertIsolationVerified: true,
      futureCiUsesNonProductionProject: true,
      futureCiFullCaptureVerified: true,
      futureCiAlertIsolationVerified: true,
      ...configuration,
    },
    smoke: {
      releaseCreated: true,
      sourceMapUploadedAndSymbolicated: true,
      quotaReportingVisible: true,
      alertDeliveredToVerifiedOperator: true,
      ingestion429Observed: true,
      generatedRegionEndpointAcceptedEvent: true,
    },
    runtime: {
      errorCaptureKillSwitchTested: true,
      tracingKillSwitchTested: true,
    },
  });

const makeProjectObservation = (
  overrides: Partial<SentryProjectObservation> = {}
): SentryProjectObservation => ({
  activeClientKeyRateLimits: [Option.none()],
  environments: ["production"],
  ...overrides,
});

const makeObservation = (
  overrides: Partial<SentryAccountObservation> = {}
): SentryAccountObservation => ({
  _tag: "available",
  storageRegion: Option.some("us"),
  projectsAreDistinct: true,
  production: Option.some(makeProjectObservation()),
  nonProduction: Option.some(
    makeProjectObservation({
      activeClientKeyRateLimits: [Option.some({ windowSeconds: 86_400, errorCount: 100 })],
      environments: ["local"],
    })
  ),
  ...overrides,
});

it("verifies the live account when API observations and operator evidence match policy", () => {
  const report = verifySentryAccount({
    observation: makeObservation(),
    evidence: Option.some(makeEvidence()),
  });

  expect(report.overall).toBe("verified");
  expect(report.findings.every((finding) => finding.status === "verified")).toBe(true);
  expect(report.findings.find((finding) => finding.check === "project-separation")).toEqual({
    check: "project-separation",
    status: "verified",
    source: "live-api",
  });
  expect(
    report.findings.find((finding) => finding.check === "non-production-error-ceiling")
  ).toEqual({
    check: "non-production-error-ceiling",
    status: "verified",
    source: "live-api",
  });
});

it("keeps public Developer-plan assumptions separate from missing live evidence", () => {
  const report = verifySentryAccount({ observation: makeObservation(), evidence: Option.none() });

  expect(report.overall).toBe("incomplete");
  expect(report.findings.find((finding) => finding.check === "developer-plan")).toEqual({
    check: "developer-plan",
    status: "manual-check",
    source: "none",
  });
  expect(report.findings.find((finding) => finding.check === "live-quotas-and-reset")).toEqual({
    check: "live-quotas-and-reset",
    status: "manual-check",
    source: "none",
  });
});

it("keeps unavailable management API observations as manual checks", () => {
  const report = verifySentryAccount({
    observation: { _tag: "unavailable" },
    evidence: Option.some(makeEvidence()),
  });

  for (const check of [
    "storage-region",
    "project-separation",
    "generated-client-keys",
    "explicit-environments",
    "non-production-error-ceiling",
    "management-api-availability",
    "production-key-unlimited",
  ] as const) {
    expect(report.findings.find((finding) => finding.check === check)).toEqual({
      check,
      status: "manual-check",
      source: "unavailable",
    });
  }
  for (const check of [
    "production-spike-protection-disabled",
    "production-hard-quota-drops-accepted",
  ] as const) {
    expect(report.findings.find((finding) => finding.check === check)).toEqual({
      check,
      status: "verified",
      source: "operator-evidence",
    });
  }
});

it("requires explicit production defect-drop attestations", () => {
  const report = verifySentryAccount({
    observation: makeObservation(),
    evidence: Option.some(
      makeEvidence({
        productionSpikeProtectionDisabled: false,
        productionHardQuotaDropsAccepted: false,
      })
    ),
  });

  for (const check of [
    "production-spike-protection-disabled",
    "production-hard-quota-drops-accepted",
  ] as const) {
    expect(report.findings.find((finding) => finding.check === check)).toEqual({
      check,
      status: "mismatch",
      source: "operator-evidence",
    });
  }
});

it("rejects any active key whose quota conflicts with its project policy", () => {
  const observation = makeObservation({
    production: Option.some(
      makeProjectObservation({
        activeClientKeyRateLimits: [
          Option.none(),
          Option.some({ windowSeconds: 60, errorCount: 1 }),
        ],
      })
    ),
    nonProduction: Option.some(
      makeProjectObservation({
        activeClientKeyRateLimits: [
          Option.some({ windowSeconds: 86_400, errorCount: 100 }),
          Option.none(),
        ],
        environments: ["local"],
      })
    ),
  });
  const report = verifySentryAccount({ observation, evidence: Option.some(makeEvidence()) });

  expect(report.overall).toBe("mismatch");
  expect(
    report.findings.find((finding) => finding.check === "production-key-unlimited")?.status
  ).toBe("mismatch");
  expect(
    report.findings.find((finding) => finding.check === "non-production-error-ceiling")?.status
  ).toBe("mismatch");
});

it("requires scrubbing evidence for both projects and every production alert threshold", () => {
  const report = verifySentryAccount({
    observation: makeObservation(),
    evidence: Option.some(
      makeEvidence({
        nonProductionScrubbedFields: scrubbedFields.filter((field) => field !== "request"),
        productionAlerts: {
          ...makeEvidence().configuration.productionAlerts,
          apiP95Seconds: 3,
          verifiedOperatorRecipientOnly: false,
        },
      })
    ),
  });

  expect(report.findings.find((finding) => finding.check === "server-side-scrubbing")?.status).toBe(
    "mismatch"
  );
  expect(report.findings.find((finding) => finding.check === "production-alerts")?.status).toBe(
    "mismatch"
  );
});

it("verifies future ci policy without requiring the environment before CI telemetry exists", () => {
  const report = verifySentryAccount({
    observation: makeObservation(),
    evidence: Option.some(makeEvidence()),
  });

  expect(report.findings.find((finding) => finding.check === "explicit-environments")?.status).toBe(
    "verified"
  );
  expect(report.findings.find((finding) => finding.check === "future-ci-policy")?.status).toBe(
    "verified"
  );
});

it("rejects future ci routing or alert isolation that differs from policy", () => {
  const report = verifySentryAccount({
    observation: makeObservation(),
    evidence: Option.some(makeEvidence({ futureCiAlertIsolationVerified: false })),
  });

  expect(report.findings.find((finding) => finding.check === "future-ci-policy")?.status).toBe(
    "mismatch"
  );
});

it("rejects one project supplied for both policy roles", () => {
  const report = verifySentryAccount({
    observation: makeObservation({ projectsAreDistinct: false }),
    evidence: Option.some(makeEvidence()),
  });

  expect(report.findings.find((finding) => finding.check === "project-separation")?.status).toBe(
    "mismatch"
  );
});

it("rejects impossible dates, negative account values, and duplicate scrub fields", () => {
  const decode = Schema.decodeUnknownExit(SentryOperatorEvidence);
  const encoded = {
    ...makeEvidence(),
    observedAt: "2026-13-40T12:00:00Z",
    account: { ...makeEvidence().account, errorQuota: -1 },
    configuration: {
      ...makeEvidence().configuration,
      productionScrubbedFields: ["request", "request"],
    },
  };

  expect(decode(encoded)._tag).toBe("Failure");
});

it("rejects incomplete or internally inconsistent report values", () => {
  const decode = Schema.decodeUnknownExit(SentryVerificationReport);

  expect(
    decode({
      policyRevision: 1,
      overall: "verified",
      findings: [{ check: "developer-plan", status: "manual-check", source: "none" }],
      quotaResponseActions: [],
    })._tag
  ).toBe("Failure");
});

it("renders only the complete closed secret-free verification shape", () => {
  const report = verifySentryAccount({ observation: makeObservation(), evidence: Option.none() });
  const rendered = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
  )(renderSentryVerificationReport(report));

  expect(Object.keys(rendered).sort()).toEqual([
    "findings",
    "overall",
    "policyRevision",
    "quotaResponseActions",
  ]);
  expect(Array.isArray(rendered.findings) ? rendered.findings : []).toHaveLength(28);
  expect(rendered.quotaResponseActions).toEqual([
    { quota: "spans", usagePercentage: 50, action: "alert-and-review" },
    {
      quota: "spans",
      usagePercentage: 75,
      action: "reduce-production-roots-to-5%-and-disable-local",
    },
    { quota: "spans", usagePercentage: 90, action: "reduce-production-roots-to-1%" },
    {
      quota: "errors",
      usagePercentage: 75,
      action: "disable-local-errors-investigate-keep-production-unsampled",
    },
  ]);
});
