import { DateTime, Option, Schema } from "effect";

/** The bounded storage-region codes that may appear in secret-free evidence and reports. */
export const SentryStorageRegion = Schema.Literals(["us", "eu"]);
export type SentryStorageRegion = typeof SentryStorageRegion.Type;

/** A sensitive event-data category that must be removed by each project's server scrubber. */
export const SentryScrubField = Schema.Literals([
  "request",
  "user",
  "breadcrumb",
  "message",
  "exception-value",
  "span",
  "geo",
  "ai",
  "database",
  "arbitrary-context",
]);
export type SentryScrubField = typeof SentryScrubField.Type;

const validDateTime = Schema.makeFilter((value: string) =>
  Option.isSome(DateTime.make(value)) ? undefined : "Expected a valid calendar date or instant"
);
const IsoInstant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u),
  validDateTime
);
const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u), validDateTime);
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const developerRetentionDays = 30;
const secondsPerDay = 86_400;
const nonProductionDailyErrorCeiling = 100;
const operationalFailureOccurrences = 5;
const operationalFailureWindowMinutes = 10;
const apiP95Seconds = 2;
const latencyWindowMinutes = 15;
const queueP95Milliseconds = 60_000;
const firstQuotaAlertPercentage = 50;
const secondQuotaAlertPercentage = 75;
const thirdQuotaAlertPercentage = 90;
const quotaUsagePercentages = [
  firstQuotaAlertPercentage,
  secondQuotaAlertPercentage,
  thirdQuotaAlertPercentage,
] as const;

/** Operator-attested values copied from the live account UI after completing the runbook. */
export const SentryOperatorEvidence = Schema.Struct({
  version: Schema.Literal(1),
  observedAt: IsoInstant,
  account: Schema.Struct({
    plan: Schema.String,
    isTrial: Schema.Boolean,
    isLegacy: Schema.Boolean,
    errorQuota: NonNegativeInt,
    spanQuota: NonNegativeInt,
    quotaResetAt: IsoInstant,
    retentionDays: NonNegativeInt,
    maximumMembers: NonNegativeInt,
    storageRegion: SentryStorageRegion,
  }),
  compliance: Schema.Struct({
    processingTermsReviewed: Schema.Boolean,
    processingTermsEffectiveDate: IsoDate,
    subprocessorsReviewed: Schema.Boolean,
    subprocessorListCheckedAt: IsoInstant,
    regionOnlyProcessingClaimed: Schema.Boolean,
  }),
  configuration: Schema.Struct({
    productionSpikeProtectionDisabled: Schema.Boolean,
    productionHardQuotaDropsAccepted: Schema.Boolean,
    productionScrubbedFields: Schema.UniqueArray(SentryScrubField),
    nonProductionScrubbedFields: Schema.UniqueArray(SentryScrubField),
    verifiedOperatorRecipientCount: Schema.Literal(1),
    productionAlerts: Schema.Struct({
      newRegressedDefectImmediate: Schema.Boolean,
      operationalFailureErrorCode: Schema.Literal("operational_failure"),
      operationalFailureOccurrences: NonNegativeInt,
      operationalFailureWindowMinutes: NonNegativeInt,
      apiSpanOperation: Schema.Literal("http.server"),
      apiP95Seconds: NonNegativeInt,
      apiP95WindowMinutes: NonNegativeInt,
      queueDelayField: Schema.Literal("fidy.delay_milliseconds"),
      queueP95Milliseconds: NonNegativeInt,
      queueP95WindowMinutes: NonNegativeInt,
      quotaUsagePercentages: Schema.UniqueArray(NonNegativeInt),
      productionProjectOnly: Schema.Boolean,
      productionEnvironmentOnly: Schema.Boolean,
      verifiedOperatorRecipientOnly: Schema.Boolean,
    }),
    localAlertIsolationVerified: Schema.Boolean,
    futureCiUsesNonProductionProject: Schema.Boolean,
    futureCiFullCaptureVerified: Schema.Boolean,
    futureCiAlertIsolationVerified: Schema.Boolean,
  }),
  smoke: Schema.Struct({
    releaseCreated: Schema.Boolean,
    sourceMapUploadedAndSymbolicated: Schema.Boolean,
    quotaReportingVisible: Schema.Boolean,
    alertDeliveredToVerifiedOperator: Schema.Boolean,
    ingestion429Observed: Schema.Boolean,
    generatedRegionEndpointAcceptedEvent: Schema.Boolean,
  }),
  runtime: Schema.Struct({
    errorCaptureKillSwitchTested: Schema.Boolean,
    tracingKillSwitchTested: Schema.Boolean,
  }),
});
export type SentryOperatorEvidence = typeof SentryOperatorEvidence.Type;

/** A client-key error ceiling returned by Sentry's read-only project API. */
export type SentryClientKeyRateLimit = Readonly<{
  windowSeconds: number;
  errorCount: number;
}>;

/** Sanitized API-visible state for one expected Sentry project. */
export type SentryProjectObservation = Readonly<{
  activeClientKeyRateLimits: ReadonlyArray<Option.Option<SentryClientKeyRateLimit>>;
  environments: ReadonlyArray<string>;
}>;

/** Account facts returned by the read-only management API, stripped of every account locator. */
export type SentryAccountObservation =
  | Readonly<{ _tag: "unavailable" }>
  | Readonly<{
      _tag: "available";
      storageRegion: Option.Option<SentryStorageRegion>;
      projectsAreDistinct: boolean;
      production: Option.Option<SentryProjectObservation>;
      nonProduction: Option.Option<SentryProjectObservation>;
    }>;

/** The closed set of policy checks that a secret-free verification report may name. */
export const SentryAccountCheck = Schema.Literals([
  "developer-plan",
  "live-quotas-and-reset",
  "retention",
  "one-user-constraint",
  "storage-region",
  "processing-terms",
  "project-separation",
  "generated-client-keys",
  "explicit-environments",
  "future-ci-policy",
  "non-production-error-ceiling",
  "production-key-unlimited",
  "production-spike-protection-disabled",
  "production-hard-quota-drops-accepted",
  "server-side-scrubbing",
  "operator-email",
  "production-alerts",
  "non-production-alert-isolation",
  "release-creation",
  "source-map-upload",
  "quota-reporting",
  "alert-delivery",
  "ingestion-429",
  "generated-region-endpoint",
  "management-api-availability",
  "error-capture-kill-switch",
  "tracing-kill-switch",
  "quota-response-actions",
]);
export type SentryAccountCheck = typeof SentryAccountCheck.Type;

/** The evidence state assigned to one account-policy check. */
export const SentryFindingStatus = Schema.Literals([
  "verified",
  "assumed",
  "mismatch",
  "manual-check",
]);
export type SentryFindingStatus = typeof SentryFindingStatus.Type;

/** The bounded provenance categories allowed in a verification finding. */
export const SentryFindingSource = Schema.Literals([
  "live-api",
  "operator-evidence",
  "public-documentation",
  "checked-in-policy",
  "unavailable",
  "none",
]);
export type SentryFindingSource = typeof SentryFindingSource.Type;

/** One secret-free result tying a policy check to its status and evidence provenance. */
export const SentryAccountFinding = Schema.Struct({
  check: SentryAccountCheck,
  status: SentryFindingStatus,
  source: SentryFindingSource,
});
export type SentryAccountFinding = typeof SentryAccountFinding.Type;

/** One explicit operator action taken when shared account quota reaches a threshold. */
export const SentryQuotaResponseAction = Schema.Struct({
  quota: Schema.Literals(["spans", "errors"]),
  usagePercentage: NonNegativeInt,
  action: Schema.Literals([
    "alert-and-review",
    "reduce-production-roots-to-5%-and-disable-local",
    "reduce-production-roots-to-1%",
    "disable-local-errors-investigate-keep-production-unsampled",
  ]),
});
export type SentryQuotaResponseAction = typeof SentryQuotaResponseAction.Type;

const quotaResponseActions: ReadonlyArray<SentryQuotaResponseAction> = [
  {
    quota: "spans",
    usagePercentage: firstQuotaAlertPercentage,
    action: "alert-and-review",
  },
  {
    quota: "spans",
    usagePercentage: secondQuotaAlertPercentage,
    action: "reduce-production-roots-to-5%-and-disable-local",
  },
  {
    quota: "spans",
    usagePercentage: thirdQuotaAlertPercentage,
    action: "reduce-production-roots-to-1%",
  },
  {
    quota: "errors",
    usagePercentage: secondQuotaAlertPercentage,
    action: "disable-local-errors-investigate-keep-production-unsampled",
  },
];

const reportWithoutMismatch = (
  findings: ReadonlyArray<SentryAccountFinding>
): "verified" | "incomplete" =>
  findings.some((item) => ["manual-check", "assumed"].includes(item.status))
    ? "incomplete"
    : "verified";

const reportOverall = (
  findings: ReadonlyArray<SentryAccountFinding>
): "verified" | "mismatch" | "incomplete" =>
  findings.some((item) => item.status === "mismatch")
    ? "mismatch"
    : reportWithoutMismatch(findings);

const reportFindingsMatch = (findings: ReadonlyArray<SentryAccountFinding>): boolean =>
  findings.length === SentryAccountCheck.literals.length &&
  findings.every((item, index) => item.check === SentryAccountCheck.literals[index]);

const reportActionsMatch = (actions: ReadonlyArray<SentryQuotaResponseAction>): boolean =>
  actions.length === quotaResponseActions.length &&
  actions.every((item, index) => {
    const expected = quotaResponseActions[index];
    return (
      expected !== undefined &&
      item.quota === expected.quota &&
      item.usagePercentage === expected.usagePercentage &&
      item.action === expected.action
    );
  });

const SentryVerificationReportShape = Schema.Struct({
  policyRevision: Schema.Literal(1),
  overall: Schema.Literals(["verified", "mismatch", "incomplete"]),
  findings: Schema.Array(SentryAccountFinding),
  quotaResponseActions: Schema.Array(SentryQuotaResponseAction),
});

/** The complete, internally consistent report safe to write beneath the ignored reports directory. */
export const SentryVerificationReport = SentryVerificationReportShape.check(
  Schema.makeFilter((value) =>
    reportFindingsMatch(value.findings) &&
    reportActionsMatch(value.quotaResponseActions) &&
    value.overall === reportOverall(value.findings)
      ? undefined
      : "Expected a complete and internally consistent verification report"
  )
);
export type SentryVerificationReport = typeof SentryVerificationReport.Type;

const finding = (
  check: SentryAccountCheck,
  matches: boolean,
  source: SentryFindingSource
): SentryAccountFinding => ({ check, status: matches ? "verified" : "mismatch", source });

const manual = (check: SentryAccountCheck): SentryAccountFinding => ({
  check,
  status: "manual-check",
  source: "none",
});

const unavailable = (check: SentryAccountCheck): SentryAccountFinding => ({
  check,
  status: "manual-check",
  source: "unavailable",
});

const hasEnvironment = (project: SentryProjectObservation, environment: string): boolean =>
  project.environments.includes(environment);

const allScrubFields: ReadonlyArray<SentryScrubField> = SentryScrubField.literals;

const assumed = (check: SentryAccountCheck): SentryAccountFinding => ({
  check,
  status: "assumed",
  source: "public-documentation",
});

const operatorFinding = (
  check: SentryAccountCheck,
  evidence: Option.Option<SentryOperatorEvidence>,
  matches: (value: SentryOperatorEvidence) => boolean
): SentryAccountFinding =>
  Option.match(evidence, {
    onNone: () => manual(check),
    onSome: (value) => finding(check, matches(value), "operator-evidence"),
  });

const assumedOperatorFinding = (
  check: SentryAccountCheck,
  evidence: Option.Option<SentryOperatorEvidence>,
  matches: (value: SentryOperatorEvidence) => boolean
): SentryAccountFinding =>
  Option.match(evidence, {
    onNone: () => assumed(check),
    onSome: (value) => finding(check, matches(value), "operator-evidence"),
  });

const allActiveKeysMatch = (
  project: SentryProjectObservation,
  predicate: (limit: Option.Option<SentryClientKeyRateLimit>) => boolean
): boolean =>
  project.activeClientKeyRateLimits.length > 0 &&
  project.activeClientKeyRateLimits.every(predicate);

const allScrubFieldsPresent = (fields: ReadonlyArray<SentryScrubField>): boolean =>
  allScrubFields.every((field) => fields.includes(field));

const productionAlertsMatch = (value: SentryOperatorEvidence): boolean => {
  const alerts = value.configuration.productionAlerts;
  return [
    alerts.newRegressedDefectImmediate,
    alerts.operationalFailureOccurrences === operationalFailureOccurrences,
    alerts.operationalFailureWindowMinutes === operationalFailureWindowMinutes,
    alerts.apiP95Seconds === apiP95Seconds,
    alerts.apiP95WindowMinutes === latencyWindowMinutes,
    alerts.queueP95Milliseconds === queueP95Milliseconds,
    alerts.queueP95WindowMinutes === latencyWindowMinutes,
    alerts.quotaUsagePercentages.length === quotaUsagePercentages.length,
    quotaUsagePercentages.every((percentage) => alerts.quotaUsagePercentages.includes(percentage)),
    alerts.productionProjectOnly,
    alerts.productionEnvironmentOnly,
    alerts.verifiedOperatorRecipientOnly,
  ].every(Boolean);
};

const observedProject = (
  observation: SentryAccountObservation,
  project: "production" | "nonProduction"
): Option.Option<SentryProjectObservation> =>
  observation._tag === "available" ? observation[project] : Option.none();

const storageRegionFinding = (
  observation: SentryAccountObservation,
  evidence: Option.Option<SentryOperatorEvidence>
): SentryAccountFinding => {
  if (observation._tag === "unavailable") return unavailable("storage-region");
  return Option.match(observation.storageRegion, {
    onNone: () => manual("storage-region"),
    onSome: (region) =>
      finding(
        "storage-region",
        Option.match(evidence, {
          onNone: () => true,
          onSome: (value) => value.account.storageRegion === region,
        }),
        "live-api"
      ),
  });
};

type AccountEvidenceFindings = Readonly<
  Record<
    | "developer-plan"
    | "live-quotas-and-reset"
    | "retention"
    | "one-user-constraint"
    | "processing-terms",
    SentryAccountFinding
  >
>;
type ApiObservationFindings = Readonly<
  Record<
    | "project-separation"
    | "generated-client-keys"
    | "explicit-environments"
    | "non-production-error-ceiling"
    | "production-key-unlimited"
    | "management-api-availability",
    SentryAccountFinding
  >
>;
type ConfigurationEvidenceFindings = Readonly<
  Record<
    | "future-ci-policy"
    | "production-spike-protection-disabled"
    | "production-hard-quota-drops-accepted"
    | "server-side-scrubbing"
    | "operator-email"
    | "production-alerts"
    | "non-production-alert-isolation",
    SentryAccountFinding
  >
>;
type SmokeAndRuntimeFindings = Readonly<
  Record<
    | "release-creation"
    | "source-map-upload"
    | "quota-reporting"
    | "alert-delivery"
    | "ingestion-429"
    | "generated-region-endpoint"
    | "error-capture-kill-switch"
    | "tracing-kill-switch"
    | "quota-response-actions",
    SentryAccountFinding
  >
>;

const accountEvidenceFindings = (
  evidence: Option.Option<SentryOperatorEvidence>
): AccountEvidenceFindings => ({
  "developer-plan": operatorFinding("developer-plan", evidence, (value) =>
    [value.account.plan === "developer", !value.account.isTrial, !value.account.isLegacy].every(
      Boolean
    )
  ),
  "live-quotas-and-reset": operatorFinding(
    "live-quotas-and-reset",
    evidence,
    (value) => value.account.errorQuota > 0 && value.account.spanQuota > 0
  ),
  retention: assumedOperatorFinding(
    "retention",
    evidence,
    (value) => value.account.retentionDays === developerRetentionDays
  ),
  "one-user-constraint": assumedOperatorFinding(
    "one-user-constraint",
    evidence,
    (value) => value.account.maximumMembers === 1
  ),
  "processing-terms": operatorFinding("processing-terms", evidence, (value) =>
    [
      value.compliance.processingTermsReviewed,
      value.compliance.subprocessorsReviewed,
      !value.compliance.regionOnlyProcessingClaimed,
    ].every(Boolean)
  ),
});

const apiObservationFindings = (observation: SentryAccountObservation): ApiObservationFindings => {
  if (observation._tag === "unavailable") {
    return {
      "project-separation": unavailable("project-separation"),
      "generated-client-keys": unavailable("generated-client-keys"),
      "explicit-environments": unavailable("explicit-environments"),
      "non-production-error-ceiling": unavailable("non-production-error-ceiling"),
      "production-key-unlimited": unavailable("production-key-unlimited"),
      "management-api-availability": unavailable("management-api-availability"),
    };
  }
  const production = observedProject(observation, "production");
  const nonProduction = observedProject(observation, "nonProduction");
  const separated =
    observation.projectsAreDistinct && Option.isSome(production) && Option.isSome(nonProduction);
  return {
    "project-separation": finding("project-separation", separated, "live-api"),
    "generated-client-keys": finding(
      "generated-client-keys",
      Option.exists(production, (project) => project.activeClientKeyRateLimits.length > 0) &&
        Option.exists(nonProduction, (project) => project.activeClientKeyRateLimits.length > 0),
      "live-api"
    ),
    "explicit-environments": finding(
      "explicit-environments",
      Option.exists(production, (project) => hasEnvironment(project, "production")) &&
        Option.exists(nonProduction, (project) => hasEnvironment(project, "local")),
      "live-api"
    ),
    "non-production-error-ceiling": finding(
      "non-production-error-ceiling",
      Option.exists(nonProduction, (project) =>
        allActiveKeysMatch(
          project,
          Option.exists(
            (limit) =>
              limit.windowSeconds === secondsPerDay &&
              limit.errorCount === nonProductionDailyErrorCeiling
          )
        )
      ),
      "live-api"
    ),
    "production-key-unlimited": finding(
      "production-key-unlimited",
      Option.exists(production, (project) => allActiveKeysMatch(project, Option.isNone)),
      "live-api"
    ),
    "management-api-availability": finding("management-api-availability", true, "live-api"),
  };
};

const configurationEvidenceFindings = (
  evidence: Option.Option<SentryOperatorEvidence>
): ConfigurationEvidenceFindings => ({
  "future-ci-policy": operatorFinding("future-ci-policy", evidence, (value) =>
    [
      value.configuration.futureCiUsesNonProductionProject,
      value.configuration.futureCiFullCaptureVerified,
      value.configuration.futureCiAlertIsolationVerified,
    ].every(Boolean)
  ),
  "production-spike-protection-disabled": operatorFinding(
    "production-spike-protection-disabled",
    evidence,
    (value) => value.configuration.productionSpikeProtectionDisabled
  ),
  "production-hard-quota-drops-accepted": operatorFinding(
    "production-hard-quota-drops-accepted",
    evidence,
    (value) => value.configuration.productionHardQuotaDropsAccepted
  ),
  "server-side-scrubbing": operatorFinding("server-side-scrubbing", evidence, (value) =>
    [
      allScrubFieldsPresent(value.configuration.productionScrubbedFields),
      allScrubFieldsPresent(value.configuration.nonProductionScrubbedFields),
    ].every(Boolean)
  ),
  "operator-email": operatorFinding("operator-email", evidence, (value) =>
    Boolean(value.configuration.verifiedOperatorRecipientCount)
  ),
  "production-alerts": operatorFinding("production-alerts", evidence, productionAlertsMatch),
  "non-production-alert-isolation": operatorFinding(
    "non-production-alert-isolation",
    evidence,
    (value) => value.configuration.localAlertIsolationVerified
  ),
});

const smokeAndRuntimeFindings = (
  evidence: Option.Option<SentryOperatorEvidence>
): SmokeAndRuntimeFindings => ({
  "release-creation": operatorFinding("release-creation", evidence, (value) =>
    Boolean(value.smoke.releaseCreated)
  ),
  "source-map-upload": operatorFinding(
    "source-map-upload",
    evidence,
    (value) => value.smoke.sourceMapUploadedAndSymbolicated
  ),
  "quota-reporting": operatorFinding("quota-reporting", evidence, (value) =>
    Boolean(value.smoke.quotaReportingVisible)
  ),
  "alert-delivery": operatorFinding(
    "alert-delivery",
    evidence,
    (value) => value.smoke.alertDeliveredToVerifiedOperator
  ),
  "ingestion-429": operatorFinding("ingestion-429", evidence, (value) =>
    Boolean(value.smoke.ingestion429Observed)
  ),
  "generated-region-endpoint": operatorFinding(
    "generated-region-endpoint",
    evidence,
    (value) => value.smoke.generatedRegionEndpointAcceptedEvent
  ),
  "error-capture-kill-switch": operatorFinding(
    "error-capture-kill-switch",
    evidence,
    (value) => value.runtime.errorCaptureKillSwitchTested
  ),
  "tracing-kill-switch": operatorFinding("tracing-kill-switch", evidence, (value) =>
    Boolean(value.runtime.tracingKillSwitchTested)
  ),
  "quota-response-actions": finding("quota-response-actions", true, "checked-in-policy"),
});

const findingsByCheck = (input: {
  readonly observation: SentryAccountObservation;
  readonly evidence: Option.Option<SentryOperatorEvidence>;
}): Readonly<Record<SentryAccountCheck, SentryAccountFinding>> => ({
  ...accountEvidenceFindings(input.evidence),
  "storage-region": storageRegionFinding(input.observation, input.evidence),
  ...apiObservationFindings(input.observation),
  ...configurationEvidenceFindings(input.evidence),
  ...smokeAndRuntimeFindings(input.evidence),
});

/** Compares sanitized API observations and optional live-account evidence with Fidy's policy. */
export const verifySentryAccount = (input: {
  readonly observation: SentryAccountObservation;
  readonly evidence: Option.Option<SentryOperatorEvidence>;
}): SentryVerificationReport => {
  const byCheck = findingsByCheck(input);
  const findings = SentryAccountCheck.literals.map((check) => byCheck[check]);
  return {
    policyRevision: 1,
    overall: reportOverall(findings),
    findings,
    quotaResponseActions,
  };
};

const SentryVerificationReportJson = Schema.fromJsonString(SentryVerificationReport);

/** Serializes only the closed report schema; account locators and provider payloads cannot enter it. */
export const renderSentryVerificationReport = (report: SentryVerificationReport): string =>
  Schema.encodeUnknownSync(SentryVerificationReportJson)(report);
