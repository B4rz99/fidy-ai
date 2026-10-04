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
