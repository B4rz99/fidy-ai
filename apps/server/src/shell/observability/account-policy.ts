import { jsonStringSchema } from "~/schema-compatibility";
import { Option, Schema } from "effect";

/** The bounded storage-region codes returned by Sentry's read-only organization API. */
export const SentryStorageRegion = Schema.Literals(["us", "eu"]);
export type SentryStorageRegion = typeof SentryStorageRegion.Type;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const secondsPerDay = 86_400;
const nonProductionDailyErrorCeiling = 100;
const firstQuotaAlertPercentage = 50;
const secondQuotaAlertPercentage = 75;
const thirdQuotaAlertPercentage = 90;

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

/** The closed set of account checks that can be proved automatically. */
export const SentryAccountCheck = Schema.Literals([
  "storage-region",
  "project-separation",
  "generated-client-keys",
  "explicit-environments",
  "non-production-error-ceiling",
  "production-key-unlimited",
  "management-api-availability",
  "quota-response-actions",
]);
export type SentryAccountCheck = typeof SentryAccountCheck.Type;

/** The evidence state assigned to one automated account-policy check. */
export const SentryFindingStatus = Schema.Literals(["verified", "mismatch"]);
export type SentryFindingStatus = typeof SentryFindingStatus.Type;

/** The bounded provenance categories allowed in a verification finding. */
export const SentryFindingSource = Schema.Literals([
  "live-api",
  "checked-in-policy",
  "unavailable",
]);
export type SentryFindingSource = typeof SentryFindingSource.Type;

/** One secret-free result tying a policy check to its status and evidence provenance. */
export const SentryAccountFinding = Schema.Struct({
  check: SentryAccountCheck,
  status: SentryFindingStatus,
  source: SentryFindingSource,
});
export type SentryAccountFinding = typeof SentryAccountFinding.Type;

/** One prescribed response when shared account quota reaches a threshold. */
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

const reportOverall = (findings: ReadonlyArray<SentryAccountFinding>): "verified" | "mismatch" =>
  findings.some((item) => item.status === "mismatch") ? "mismatch" : "verified";

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
  policyRevision: Schema.Literal(2),
  overall: Schema.Literals(["verified", "mismatch"]),
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

const unavailable = (check: SentryAccountCheck): SentryAccountFinding => ({
  check,
  status: "mismatch",
  source: "unavailable",
});

const hasEnvironment = (project: SentryProjectObservation, environment: string): boolean =>
  project.environments.includes(environment);

const allActiveKeysMatch = (
  project: SentryProjectObservation,
  predicate: (limit: Option.Option<SentryClientKeyRateLimit>) => boolean
): boolean =>
  project.activeClientKeyRateLimits.length > 0 &&
  project.activeClientKeyRateLimits.every(predicate);

const observedProject = (
  observation: SentryAccountObservation,
  project: "production" | "nonProduction"
): Option.Option<SentryProjectObservation> =>
  observation._tag === "available" ? observation[project] : Option.none();

const storageRegionFinding = (observation: SentryAccountObservation): SentryAccountFinding => {
  if (observation._tag === "unavailable") return unavailable("storage-region");
  return Option.match(observation.storageRegion, {
    onNone: () => unavailable("storage-region"),
    onSome: () => finding("storage-region", true, "live-api"),
  });
};

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

const findingsByCheck = (
  observation: SentryAccountObservation
): Readonly<Record<SentryAccountCheck, SentryAccountFinding>> => ({
  "storage-region": storageRegionFinding(observation),
  ...apiObservationFindings(observation),
  "quota-response-actions": finding("quota-response-actions", true, "checked-in-policy"),
});

/** Compares sanitized API observations with Fidy's automated Sentry policy. */
export const verifySentryAccount = (input: {
  readonly observation: SentryAccountObservation;
}): SentryVerificationReport => {
  const byCheck = findingsByCheck(input.observation);
  const findings = SentryAccountCheck.literals.map((check) => byCheck[check]);
  return {
    policyRevision: 2,
    overall: reportOverall(findings),
    findings,
    quotaResponseActions,
  };
};

const SentryVerificationReportJson = jsonStringSchema(SentryVerificationReport);

/** Serializes only the closed report schema; account locators and provider payloads cannot enter it. */
export const renderSentryVerificationReport = (report: SentryVerificationReport): string =>
  Schema.encodeUnknownSync(SentryVerificationReportJson)(report);
