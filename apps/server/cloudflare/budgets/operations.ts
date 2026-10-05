import { Effect } from "effect";
import { readGroups } from "./internal/budget-proactivity";
import type { BudgetCrossing } from "../../src/core/budgets/contract";
import { type BudgetCrossingRead, BudgetCrossingUnavailable } from "./contract";
import { readCrossings } from "./internal/budget-crossings";
import { readConsentStatus } from "../consent/operations";

import {
  prepareCreateBudget as createBudget,
  prepareDeleteBudget as deleteBudget,
  prepareUpdateBudget as updateBudget,
} from "./internal/budgets";
import {
  browseBudgets as browse,
  listOwnedBudgets as caps,
  currentBudgetReport as spending,
} from "./internal/budget-queries";
import { reconcileBudgetLatches as evaluateAlerts } from "./internal/budget-latches";
import { budgetRefusal as refuse } from "./internal/budget-outcome";

/** Bounded pending same-User delivery groups retain the grant captured at detection, including explicit ineligibility. */
export const readBudgetCrossingGroups: typeof readGroups = (input) => readGroups(input);

const matchesCrossingMonth = (
  crossing: BudgetCrossing,
  input: Pick<BudgetCrossingRead, "budgetId" | "period">
): boolean =>
  crossing.budgetId === input.budgetId &&
  crossing.period.timeZone === input.period.timeZone &&
  crossing.period.from.epochMilliseconds === input.period.from.epochMilliseconds &&
  crossing.period.to.epochMilliseconds === input.period.to.epochMilliseconds;

/** Read complete immutable threshold facts for one explicit User/month under live processing Consent and caller-owned coordination. Legacy rows without captured facts are unavailable, never rebuilt from current state. */
export const readBudgetCrossings = (
  input: BudgetCrossingRead
): Effect.Effect<ReadonlyArray<BudgetCrossing>, BudgetCrossingUnavailable> =>
  Effect.gen(function* () {
    const standing = yield* readConsentStatus(input).pipe(
      Effect.mapError(() => new BudgetCrossingUnavailable())
    );
    if (standing !== "Granted") return yield* new BudgetCrossingUnavailable();
    const rows = yield* readCrossings(input);
    const thresholds = new Set<number>();
    for (const row of rows) {
      const crossing = row.crossing_json;
      if (
        thresholds.has(row.threshold) ||
        crossing.threshold !== row.threshold ||
        !matchesCrossingMonth(crossing, input)
      ) {
        return yield* new BudgetCrossingUnavailable();
      }
      thresholds.add(row.threshold);
    }
    return rows
      .map((row) => row.crossing_json)
      .sort((left, right) => left.threshold - right.threshold);
  });

/**
 * Prepare one positive cap for a known Category under live caller authority. The canonical User
 * unit commits these guarded writes with its accountability evidence or commits none of them.
 */
export const prepareCreateBudget: typeof createBudget = (input) => createBudget(input);

/**
 * Prepare a caller-owned Category/cap revision. Currency and ownership cannot change; commit-time
 * guards recheck Category existence, uniqueness, and authority without reopening monthly marks.
 */
export const prepareUpdateBudget: typeof updateBudget = (input) => updateBudget(input);

/** Prepare removal of one caller-owned Budget and its operational marks in the canonical unit. */
export const prepareDeleteBudget: typeof deleteBudget = (input) => deleteBudget(input);

/** Observe Budget facts with live authority and accountability, without advancing pending alerts. */
export const browseBudgets: typeof browse = (input) => browse(input);

/**
 * Read one User's complete, ordered public cap projection for authorized peer work. The caller
 * establishes authority and serializes that User's work; an id alone is not authority. An invalid
 * or oversized retained set is unavailable, never a partial answer.
 */
export const readBudgetCaps: typeof caps = (input) => caps(input);

/**
 * Read exact monthly spending through Transaction-owned contribution pages. The caller supplies
 * one authorized, coordinated User and an explicit IANA zone. Bounded progress is retained for
 * later calls; incomplete or changed-revision totals are unavailable, never partially returned.
 */
export const readBudgetSpending: typeof spending = (input) => spending(input);

/**
 * Evaluate one coordinated User's durable pending alert work using their current IANA zone.
 * Each 80%/100% mark is monotone and its occurrence unique for that Budget and month. False means
 * work remains or authority is unavailable; callers must drain it before a later correction.
 */
export const evaluateBudgetAlerts: typeof evaluateAlerts = (input) => evaluateAlerts(input);

/** Record and present an owner-decided refusal under the same caller's live authority. */
export const budgetRefusal: typeof refuse = (input) => refuse(input);
