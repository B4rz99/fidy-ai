import { Effect, Function, Schema } from "effect";
import { summarizeDashboardSamples } from "../e2e/dashboard-measurement";

const moderateUsers = 8;
const saturatedUsers = 32;
const pacedIntervalMs = 12000;
const improvementFactor = 10;
const fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Observation = Schema.Struct({
  journey: Schema.Literals(["direct", "return"]),
  outcome: Schema.Literals(["ready", "refused", "timeout", "no-fresh-read"]),
  user: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  tab: Schema.Literals([0, 1]),
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const DashboardCohort = Schema.Struct({
  dataset: Schema.Literals(["small", "heavy", "extreme", "breaking"]),
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  browserDigest: fingerprint,
  adapterDigest: fingerprint,
  surface: Schema.Literals(["legacy-cross-origin", "same-origin"]),
  runtime: Schema.NonEmptyString,
  compression: Schema.Literals(["identity", "gzip"]),
  build: Schema.Literal("production"),
  epoch: Schema.NonEmptyString,
  setup: Schema.Literal("ready"),
  activitySatisfied: Schema.Literal(true),
  preparedUsers: Schema.Int,
  samplesPerActor: Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 1000 })),
  sourceClean: Schema.Literal(true),
  scheduleSatisfied: Schema.Literal(true),
  requestedRevisionMatches: Schema.Literal(true),
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
}).check(
  Schema.makeFilter(
    (cohort) => cohort.users === cohort.preparedUsers || "Every configured User must finish setup"
  ),
  Schema.makeFilter(
    (cohort) =>
      cohort.samples.every((sample) => sample.user < cohort.users && sample.tab < cohort.tabs) ||
      "Samples must refer to configured actors"
  ),
  Schema.makeFilter(
    (cohort) =>
      new Set(
        cohort.samples.map(
          (sample) => `${sample.user}/${sample.tab}/${sample.journey}/${sample.attempt}`
        )
      ).size === cohort.samples.length || "Each offered navigation must appear once"
  )
);
type Cohort = typeof DashboardCohort.Type;
const matchingKeys = [
  "dataset",
  "browserDigest",
  "runtime",
  "compression",
  "build",
  "epoch",
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
  | Readonly<{
      status: "insufficient";
      requiredSuccessfulSamples: number;
      incompleteActors: number;
    }>
  | Readonly<{ status: "met" | "unmet"; maximumP95Ms: number }>;
type JourneyComparison = Readonly<{ baseline: Summary; candidate: Summary; target: Target }>;
type CohortComparison =
  | Readonly<{ status: "unmatched"; differences: ReadonlyArray<string> }>
  | Readonly<{ status: "measured"; direct: JourneyComparison; return: JourneyComparison }>;
const minimumSuccessfulSamples = 30;
const countIncompleteActors = (
  baseline: Cohort,
  candidate: Cohort,
  journey: "direct" | "return"
): number => {
  let incompleteActors = 0;
  for (let user = 0; user < baseline.users; user++) {
    for (let tab = 0; tab < baseline.tabs; tab++) {
      const matches = (sample: typeof Observation.Type): boolean =>
        sample.user === user &&
        sample.tab === tab &&
        sample.journey === journey &&
        sample.outcome === "ready";
      if (
        baseline.samples.filter(matches).length < minimumSuccessfulSamples ||
        candidate.samples.filter(matches).length < minimumSuccessfulSamples
      ) {
        incompleteActors++;
      }
    }
  }
  return incompleteActors;
};
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
  const incompleteActors = countIncompleteActors(baseline, candidate, journey);
  if (
    incompleteActors > 0 ||
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
        incompleteActors,
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
export const compareDashboardCohorts: {
  (candidate: Cohort): (baseline: Cohort) => CohortComparison;
  (baseline: Cohort, candidate: Cohort): CohortComparison;
} = Function.dual(2, (baseline: Cohort, candidate: Cohort): CohortComparison => {
  const differences = matchingKeys.filter((key) => baseline[key] !== candidate[key]);
  if (differences.length > 0) return { status: "unmatched", differences };
  return {
    status: "measured",
    direct: compareJourney(baseline, candidate, "direct"),
    return: compareJourney(baseline, candidate, "return"),
  };
});

const maximumCohortBytes = 67_108_864;
const readCohort = Effect.fn(function* (path: string) {
  const file = Bun.file(path);
  if (file.size > maximumCohortBytes) {
    return yield* Effect.fail("MeasurementArtifactTooLarge" as const);
  }
  const body = yield* Effect.tryPromise(() => file.text());
  return yield* Schema.decodeEffect(Schema.fromJsonString(DashboardCohort))(body);
});
const Arguments = Schema.Tuple([Schema.NonEmptyString, Schema.NonEmptyString]);
if (import.meta.main) {
  const program = Effect.gen(function* () {
    const [before, after] = yield* Schema.decodeUnknownEffect(Arguments)(process.argv.slice(2));
    const baseline = yield* readCohort(before);
    const candidate = yield* readCohort(after);
    return {
      browser: compareDashboardCohorts(baseline, candidate),
      completeLocalRequest: { status: "not-measured" },
      remoteApplicationAdded: { status: "not-measured" },
      remoteCompleteRequest: { status: "not-measured" },
    };
  });
  await Effect.runPromise(program).then(
    (result) =>
      process.stdout.write(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(result) + "\n"),
    () => {
      process.stderr.write(
        "Unable to qualify Dashboard artifacts: require clean, pinned, complete cohorts with thirty offers per actor.\n"
      );
      process.exitCode = 1;
    }
  );
}
