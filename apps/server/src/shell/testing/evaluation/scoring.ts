import { Function, Schema } from "effect";
import {
  type CaseResult,
  type CheckResult,
  type EvaluationCase,
  FinancialFacts,
  type Observation,
  type RunReport,
} from "./model";

const equalFacts = Schema.toEquivalence(FinancialFacts);

/** Compares an exact multiset: two equal-Money movements cannot collapse into one assertion. */
export const sameFinancialFacts: {
  (expected: ReadonlyArray<FinancialFacts>, actual: ReadonlyArray<FinancialFacts>): boolean;
  (actual: ReadonlyArray<FinancialFacts>): (expected: ReadonlyArray<FinancialFacts>) => boolean;
} = Function.dual(
  2,
  (expected: ReadonlyArray<FinancialFacts>, actual: ReadonlyArray<FinancialFacts>): boolean => {
    const unmatched = [...actual];
    for (const fact of expected) {
      const index = unmatched.findIndex((candidate) => equalFacts(fact, candidate));
      if (index < 0) return false;
      unmatched.splice(index, 1);
    }
    return unmatched.length === 0;
  }
);

/** Constructs a closed scalar result; expected and actual values never become diagnostics. */
export const check: {
  (id: CheckResult["id"], passed: boolean): CheckResult;
  (passed: boolean): (id: CheckResult["id"]) => CheckResult;
} = Function.dual(2, (id: CheckResult["id"], passed: boolean): CheckResult => ({
  id,
  critical: true,
  status: passed ? "passed" : "failed",
}));

/** Every interrupted or skipped case retains the same planned denominator as a completed case. */
const plannedChecks = (entry: EvaluationCase): ReadonlyArray<CheckResult> => {
  const commonChecks = [check("exact-financial-facts", false), check("review-outcomes", false)];
  switch (entry.kind) {
    case "hosted":
      return [
        ...commonChecks,
        check("canonical-operations", false),
        check("reply-delivered", false),
        check("reply-rubric", false),
        check("no-unexpected-mutations", false),
        ...(entry.coverage.includes("confirmation")
          ? [check("confirmation-before-effect", false)]
          : []),
      ];
    case "statement":
      return [...commonChecks, check("row-accounting", false)];
    case "email":
      return commonChecks;
    case "safety":
      return [
        check("rejection", false),
        check("no-unauthorized-effects", false),
        check("audit-evidence", false),
      ];
  }
};

/** Record-level semantic failures cannot be hidden behind schema-valid extraction or a success reply. */
export const scoreObservation: {
  (entry: EvaluationCase, observed: Observation): ReadonlyArray<CheckResult>;
  (observed: Observation): (entry: EvaluationCase) => ReadonlyArray<CheckResult>;
} = Function.dual(2, (entry: EvaluationCase, observed: Observation): ReadonlyArray<CheckResult> => {
  const reasons = observed.reviews
    .map((item) => (item.status === "pending" ? item.reason : "not-pending"))
    .toSorted();
  return [
    check("exact-financial-facts", sameFinancialFacts(entry.expected, observed.facts)),
    check(
      "review-outcomes",
      entry.reviews.length === reasons.length &&
        entry.reviews.toSorted().every((reason, index) => reason === reasons[index])
    ),
  ];
});

/** Outages, budget stops, and harness failures remain missing evidence, never passing abstention. */
export const incompleteCase: {
  (
    entry: EvaluationCase,
    repetition: number,
    outcome: Exclude<CaseResult["outcome"], "scored">
  ): CaseResult;
  (
    repetition: number,
    outcome: Exclude<CaseResult["outcome"], "scored">
  ): (entry: EvaluationCase) => CaseResult;
} = Function.dual(
  3,
  (
    entry: EvaluationCase,
    repetition: number,
    outcome: Exclude<CaseResult["outcome"], "scored">
  ): CaseResult => {
    const checks = plannedChecks(entry).map((item) => ({
      id: item.id,
      critical: item.critical,
      status: "not-observed" as const,
    }));
    const first = checks[0];
    if (first === undefined) {
      throw new Error("Every evaluation case must declare at least one check");
    }
    return {
      id: entry.id,
      repetition,
      track: entry.kind === "safety" ? "safety" : "quality",
      outcome,
      checks: [first, ...checks.slice(1)],
    };
  }
);

const countChecks = (checks: ReadonlyArray<CheckResult>): RunReport["quality"] => ({
  planned: checks.length,
  passed: checks.filter((item) => item.status === "passed").length,
  failed: checks.filter((item) => item.status === "failed").length,
  notObserved: checks.filter((item) => item.status === "not-observed").length,
});

/** Critical failures across any repetition dominate the conclusion; not-observed is never dropped. */
export const scoreRun = (
  results: ReadonlyArray<CaseResult>
): Pick<RunReport, "quality" | "safety" | "critical" | "conclusion"> => {
  const checks = results.flatMap((entry) => entry.checks);
  const critical = countChecks(checks.filter((item) => item.critical));
  let conclusion: RunReport["conclusion"] = "expectations-met";
  if (checks.some((item) => item.status === "failed")) conclusion = "expectations-failed";
  else if (
    checks.some((item) => item.status === "not-observed") ||
    results.some((entry) => entry.outcome !== "scored")
  ) {
    conclusion = "incomplete";
  }
  return {
    quality: countChecks(
      results.filter((entry) => entry.track === "quality").flatMap((entry) => entry.checks)
    ),
    safety: countChecks(
      results.filter((entry) => entry.track === "safety").flatMap((entry) => entry.checks)
    ),
    critical,
    conclusion,
  };
};
