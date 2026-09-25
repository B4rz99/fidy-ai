import type { CanonicalOperationId, ErrorCode } from "@fidy/server/canonical-runtime";
import { Effect, Exit, Option } from "effect";
import {
  dailyAuditBudget,
  dailyAuditCount,
  sharedAuditLimitRefusal,
} from "./daily-canonical-budget";

/**
 * The metadata-only refusal outcome one child's own audit table records. It is deliberately
 * narrower than the failure code: a Paywall and a submission-pressure refusal are both bounded
 * resource outcomes, and a missing or foreign record is its own evidence class.
 */
export type AtomicRefusalAuditOutcome = "not_found" | "validation_failed" | "resource_limit";

/**
 * One canonical child refusal as both the batch failure contract and the child's own individual
 * response report it. `code` is the published failure code a caller branches on; `auditOutcome` is
 * what the child's refusal AuditLogEntry records; `message` is addressed to the calling agent and
 * never carries input bodies or database detail.
 */
export type AtomicMutationRefusal = Readonly<{
  readonly code: ErrorCode;
  readonly auditOutcome: AtomicRefusalAuditOutcome;
  readonly message: string;
}>;

/** What one refusal AuditLogEntry attempt committed: a row, a dead credential, or a cause. */
export type RefusalRecord = "recorded" | "credential_refused" | "rate_limited" | "unavailable";

/**
 * One live-authority gate over a credential table: its table, predicate, and bindings. The unit
 * rechecks it after an abort so a credential revoked after dispatch refuses the work instead of
 * being reported as an unavailable authority.
 */
export type AtomicUnitAuthority = Readonly<{
  readonly table: string;
  readonly predicate: string;
  readonly bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

/**
 * One owner-prepared canonical mutation child, ready to join a caller-owned D1 unit. `statements`
 * are guard-chained writes that must all commit; the unit appends `assertion` after them, so a
 * silently skipped guard rolls the whole unit back instead of being noticed after commit.
 * `auditRows` is how many rows this child contributes to the shared daily canonical-work budget, so
 * a budget abort can name the child that met the trigger.
 */
export type AtomicUnitChild<Committed> = Readonly<{
  readonly operation: CanonicalOperationId;
  readonly statements: ReadonlyArray<D1PreparedStatement>;
  readonly assertion: D1PreparedStatement;
  readonly auditRows: number;
  /** Reads this child's committed records back after the unit commits; None when unprovable. */
  readonly readCommitted: Effect.Effect<Option.Option<Committed>>;
  /** Records this child's metadata-only refusal AuditLogEntry under the exact authority it prepared with. */
  readonly recordRefusal: (refusal: AtomicMutationRefusal) => Effect.Effect<RefusalRecord>;
}>;

/** Attributes an aborted unit to one child from the cause and state observable after rollback. */
export type AtomicAbortAttributor = (input: {
  readonly cause: unknown;
  readonly db: D1Database;
  readonly userId: string;
  readonly current: number;
}) => Effect.Effect<
  Option.Option<Readonly<{ childIndex: number; refusal: AtomicMutationRefusal }>>
>;

/**
 * What one caller-owned D1 unit did with its ordered canonical mutation children. `Attributed` is
 * not yet settled: the caller records the named child's refusal AuditLogEntry and classifies how
 * that audit settled, because an individual caller may still resolve an attributed abort as a
 * committed replay of work that won the race outside its unit.
 */
export type AtomicUnitExecution<Committed> =
  | Readonly<{ _tag: "Committed"; results: ReadonlyArray<Committed> }>
  | Readonly<{ _tag: "Attributed"; callIndex: number; refusal: AtomicMutationRefusal }>
  | Readonly<{ _tag: "CredentialRefused" }>
  | Readonly<{ _tag: "Unavailable" }>;

/** The one message both the individual caller and a batch child report for an exhausted day. */
export const dailyAuditMessage = "The caller's daily canonical write budget is exhausted.";

/** The canonical outcome when the shared daily budget itself refused a child's audit write. */
export const dailyAuditRefusal: AtomicMutationRefusal = {
  auditOutcome: "resource_limit",
  code: "rate_limited",
  message: dailyAuditMessage,
};

const authorityExists = (db: D1Database, authority: AtomicUnitAuthority): Effect.Effect<boolean> =>
  Effect.tryPromise(() =>
    db
      .prepare(`SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}`)
      .bind(...authority.bindings)
      .first()
  ).pipe(
    Effect.map((row) => row !== null),
    Effect.orElseSucceed(() => false)
  );

/**
 * The first child whose audit row insert meets the spent shared budget. Every audit table trigger
 * counts the same five tables and aborts once the day already holds the budget, so the child whose
 * cumulative audit rows would exceed the remaining allowance is the one that met it. The exhausted
 * budget is what refused the unit, so the answer is the canonical `rate_limited` refusal and no
 * refusal AuditLogEntry commits (the trigger refused that row too).
 */
const auditBudgetIndex = ({
  db,
  userId,
  current,
  children,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  children: ReadonlyArray<AtomicUnitChild<unknown>>;
}>): Effect.Effect<number> =>
  Effect.tryPromise(() => dailyAuditCount({ db, userId, current })).pipe(
    Effect.orElseSucceed(() => 0),
    Effect.map((count) => {
      let remaining = dailyAuditBudget - count;
      for (const [index, child] of children.entries()) {
        if (remaining < child.auditRows) return index;
        remaining -= child.auditRows;
      }
      return 0;
    })
  );

const classifyAborted = <Committed>({
  db,
  userId,
  current,
  authority,
  children,
  attributors,
  cause,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  authority: AtomicUnitAuthority;
  children: ReadonlyArray<AtomicUnitChild<Committed>>;
  attributors: ReadonlyArray<AtomicAbortAttributor>;
  cause: unknown;
}>): Effect.Effect<AtomicUnitExecution<Committed>> =>
  Effect.gen(function* () {
    if (!(yield* authorityExists(db, authority))) return { _tag: "CredentialRefused" } as const;
    if (sharedAuditLimitRefusal(cause)) {
      const callIndex = yield* auditBudgetIndex({ children, current, db, userId });
      return { _tag: "Attributed", callIndex, refusal: dailyAuditRefusal } as const;
    }
    for (const attributor of attributors) {
      const attributed = yield* attributor({ cause, current, db, userId }).pipe(
        Effect.orElseSucceed(() => Option.none())
      );
      if (Option.isSome(attributed)) {
        return {
          _tag: "Attributed",
          callIndex: attributed.value.childIndex,
          refusal: attributed.value.refusal,
        } as const;
      }
    }
    return { _tag: "Unavailable" } as const;
  });
/**
 * Record one attributed child refusal and classify how its own audit settled: a dead credential
 * refuses the unit, a spent budget answers `rate_limited` (the exhausted budget is what refused it),
 * and any other defect is the canonical unavailable authority. The shared daily budget refusal is
 * already the trigger's own answer, so it is attributed without attempting another audit write: a
 * refusal AuditLogEntry must not consume the day's last budget slot.
 */
export const settleAtomicRefusal = <Committed>({
  child,
  callIndex,
  refusal,
}: Readonly<{
  child: Option.Option<AtomicUnitChild<Committed>>;
  callIndex: number;
  refusal: AtomicMutationRefusal;
}>): Effect.Effect<AtomicUnitExecution<Committed>> => {
  if (Option.isNone(child)) return Effect.succeed({ _tag: "Unavailable" } as const);
  if (refusal === dailyAuditRefusal) {
    return Effect.succeed({ _tag: "Attributed", callIndex, refusal } as const);
  }
  return child.value.recordRefusal(refusal).pipe(
    Effect.map((record): AtomicUnitExecution<Committed> => {
      if (record === "credential_refused") return { _tag: "CredentialRefused" };
      if (record === "rate_limited") {
        return { _tag: "Attributed", callIndex, refusal: dailyAuditRefusal };
      }
      if (record === "unavailable") return { _tag: "Unavailable" };
      return { _tag: "Attributed", callIndex, refusal };
    }),
    Effect.orElseSucceed(() => ({ _tag: "Unavailable" }) as const)
  );
};

/**
 * Commit one ordered set of owner-prepared canonical mutation children in a single D1 atomic unit
 * and read each child's committed records back. Every child is followed by its own completion
 * assertion, so a guard that silently changes no row aborts the whole unit instead of being noticed
 * after a successful commit. The unit never opens a nested D1 unit and never performs provider work;
 * an aborted unit is classified against the same live authority, shared budget, trigger markers,
 * and post-rollback premises the individual operations check. Attribution stops at what the unit
 * can prove: an abort that maps to no child answers the canonical unavailable failure.
 */
export const executeAtomicMutationUnit = <Committed>({
  db,
  userId,
  current,
  authority,
  children,
  attributors,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  authority: AtomicUnitAuthority;
  children: ReadonlyArray<AtomicUnitChild<Committed>>;
  attributors: ReadonlyArray<AtomicAbortAttributor>;
}>): Effect.Effect<AtomicUnitExecution<Committed>> =>
  Effect.gen(function* () {
    if (children.length === 0) return { _tag: "Unavailable" } as const;
    const statements = children.flatMap((child) => [...child.statements, child.assertion]);
    const attempt = yield* Effect.exit(Effect.tryPromise(() => db.batch(statements)));
    if (Exit.isFailure(attempt)) {
      return yield* classifyAborted({
        attributors,
        authority,
        cause: attempt.cause,
        children,
        current,
        db,
        userId,
      });
    }
    const results: Array<Committed> = [];
    for (const child of children) {
      const value = yield* child.readCommitted;
      if (Option.isNone(value)) return { _tag: "Unavailable" } as const;
      results.push(value.value);
    }
    return { _tag: "Committed", results } as const;
  });
