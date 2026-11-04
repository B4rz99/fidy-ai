import { Schema } from "effect";
import { summarizeDashboardSamples } from "../e2e/dashboard-measurement";

const moderateUsers = 8;
const saturatedUsers = 32;
const pacedIntervalMs = 12000;
const improvementFactor = 10;
const fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Observation = Schema.Struct({
  journey: Schema.Literals(["direct", "return"]),
  outcome: Schema.Literals(["ready", "refused", "timeout", "no-fresh-read"]),
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const DashboardCohort = Schema.Struct({
  dataset: Schema.Literals(["small", "heavy", "extreme", "breaking"]),
  revision: Schema.NonEmptyString,
  fixtureDigest: fingerprint,
  harnessDigest: fingerprint,
  dependenciesDigest: fingerprint,
  profile: Schema.Literals(["desktop", "mobile"]),
  network: Schema.Literals(["normal", "poor"]),
  browser: Schema.NonEmptyString,
  users: Schema.Literals([1, moderateUsers, saturatedUsers]),
  tabs: Schema.Literals([1, 2]),
  ingestion: Schema.Boolean,
  history: Schema.Literals(["routine", "dense", "wide", "reconciled", "recurring"]),
  layout: Schema.Literals(["default", "maximum"]),
  pacedIntervalMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(pacedIntervalMs)),
  cpuRate: Schema.Literals([1, 4]),
  samples: Schema.Array(Observation),
});
type Cohort = typeof DashboardCohort.Type;
const matchingKeys = [
  "dataset",
  "fixtureDigest",
  "harnessDigest",
  "dependenciesDigest",
  "profile",
  "network",
  "browser",
  "users",
  "tabs",
  "ingestion",
  "history",
  "layout",
  "pacedIntervalMs",
  "cpuRate",
] as const;

type Summary = ReturnType<typeof summarizeDashboardSamples>;
type Target =
  | Readonly<{ status: "insufficient"; requiredSuccessfulSamples: number }>
  | Readonly<{ status: "met" | "unmet"; maximumP95Ms: number }>;
type JourneyComparison = Readonly<{ baseline: Summary; candidate: Summary; target: Target }>;
type CohortComparison =
  | Readonly<{ status: "unmatched"; differences: ReadonlyArray<string> }>
  | Readonly<{ status: "measured"; direct: JourneyComparison; return: JourneyComparison }>;
const minimumSuccessfulSamples = 30;
const compareJourney = (
  baseline: Cohort,
  candidate: Cohort,
  journey: "direct" | "return"
): JourneyComparison => {
  const before = summarizeDashboardSamples(
    baseline.samples.filter((sample) => sample.journey === journey)
  );
  const after = summarizeDashboardSamples(
    candidate.samples.filter((sample) => sample.journey === journey)
  );
  if (
    before.ready < minimumSuccessfulSamples ||
    after.ready < minimumSuccessfulSamples ||
    before.statistics.status === "unavailable" ||
    after.statistics.status === "unavailable"
  ) {
    return {
      baseline: before,
      candidate: after,
      target: {
        status: "insufficient",
        requiredSuccessfulSamples: minimumSuccessfulSamples,
      },
    };
  }
  const maximumP95Ms = before.statistics.p95Ms / improvementFactor;
  return {
    baseline: before,
    candidate: after,
    target: { status: after.statistics.p95Ms <= maximumP95Ms ? "met" : "unmet", maximumP95Ms },
  };
};

/** Reject unlike workloads before comparing successful fresh paints. Revision identifies each side. */
export const compareDashboardCohorts = (baseline: Cohort, candidate: Cohort): CohortComparison => {
  const differences = matchingKeys.filter((key) => baseline[key] !== candidate[key]);
  if (differences.length > 0) return { status: "unmatched", differences };
  return {
    status: "measured",
    direct: compareJourney(baseline, candidate, "direct"),
    return: compareJourney(baseline, candidate, "return"),
  };
};
