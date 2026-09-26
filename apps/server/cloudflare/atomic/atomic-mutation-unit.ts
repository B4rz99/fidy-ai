import type { CanonicalOperationId, ErrorCode } from "@fidy/server/canonical-runtime";
import { Data, Effect, Exit, Option } from "effect";
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

/**
 * The shared daily budget's own trigger refusal, tagged by cause rather than recognized by object
 * identity: it is attributed to the child that met the trigger without attempting a second audit
 * write, because a refusal AuditLogEntry must not consume the day's last budget slot.
 */
export type SharedAuditLimitRefusal = AtomicMutationRefusal &
  Readonly<{ readonly trigger: "shared_daily_audit_limit" }>;

/** Every refusal an aborted unit may attribute to a child, trigger or ordinary. */
export type AtomicUnitRefusal = AtomicMutationRefusal | SharedAuditLimitRefusal;

/** What one refusal AuditLogEntry attempt committed: a row, a dead credential, or a cause. */
export type RefusalRecord = "recorded" | "credential_refused" | "rate_limited" | "unavailable";

/**
 * One committed-record readback that failed instead of reporting an absent row. The unit retries it
 * with rollback already finished, so its cause only ever distinguishes a transient read defect from
 * a row the unit can no longer prove; it is never answered directly.
 */
export class AtomicReadbackFailed extends Data.TaggedError("AtomicReadbackFailed")<{
  readonly cause: unknown;
}> {}

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
  /**
   * Reads this child's committed records back after the unit commits; `None` when unprovable. A
   * failed read is a defect the unit itself bounds with retries, never a silent `None`.
   */
  readonly readCommitted: Effect.Effect<Option.Option<Committed>, AtomicReadbackFailed>;
  /** Records this child's metadata-only refusal AuditLogEntry under the exact authority it prepared with. */
  readonly recordRefusal: (refusal: AtomicMutationRefusal) => Effect.Effect<RefusalRecord>;
}>;

/** Attributes an aborted unit to one child from the cause and state observable after rollback. */
export type AtomicAbortAttributor = (input: {
  readonly cause: unknown;
  readonly db: D1Database;
  readonly userId: string;
  readonly current: number;
}) => Effect.Effect<Option.Option<Readonly<{ callIndex: number; refusal: AtomicUnitRefusal }>>>;

/**
 * What one caller-owned D1 unit did with its ordered canonical mutation children. `Attributed` is
 * not yet settled: the caller records the named child's refusal AuditLogEntry and classifies how
 * that audit settled, because an individual caller may still resolve an attributed abort as a
 * committed replay of work that won the race outside its unit.
 */
export type AtomicUnitExecution<Committed> =
  | Readonly<{ _tag: "Committed"; results: ReadonlyArray<Committed> }>
  | Readonly<{ _tag: "Attributed"; callIndex: number; refusal: AtomicUnitRefusal }>
  | Readonly<{ _tag: "CredentialRefused" }>
  | Readonly<{ _tag: "Unavailable" }>;

/**
 * The one message a unit reports when the shared day is exhausted at the write that the budget
 * refused: a batch child on its failure contract, and an individual statement caller whose own
 * audit write the budget stopped. A caller's own pre-check answers with its own bounded sentence
 * instead, so this is the sentence the unit's trigger path settles with.
 */
export const dailyAuditMessage = "The caller's daily canonical write budget is exhausted.";

/** The canonical outcome when the shared daily budget itself refused a child's audit write. */
export const dailyAuditRefusal: SharedAuditLimitRefusal = {
  auditOutcome: "resource_limit",
  code: "rate_limited",
  message: dailyAuditMessage,
  trigger: "shared_daily_audit_limit",
};

/**
 * The one liveness read every classification runs against a live authority gate, shared so the
 * unit and the individual boundary can never disagree about what "the credential still exists"
 * means. A failed read closes as absent: an unreadable authority refuses the work.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const liveAuthorityStatement = (
  db: D1Database,
  authority: AtomicUnitAuthority
): D1PreparedStatement =>
  db
    .prepare(`SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}`)
    .bind(...authority.bindings);

const authorityExists = (db: D1Database, authority: AtomicUnitAuthority): Effect.Effect<boolean> =>
  Effect.tryPromise(() => liveAuthorityStatement(db, authority).first()).pipe(
    Effect.map((row) => row !== null),
    Effect.orElseSucceed(() => false)
  );

/** The one child index a trigger provably belongs to when only one candidate child exists. */
export const soleIndex = (candidates: ReadonlyArray<number>): Option.Option<number> => {
  const [only, ...rest] = candidates;
  return only !== undefined && rest.length === 0 ? Option.some(only) : Option.none();
};

/**
 * The first child whose audit row insert would meet the spent shared budget, or none when the
 * recount proves no child met it. Every audit table trigger counts the same five tables and aborts
 * once the day already holds the budget, so the child whose cumulative audit rows would exceed the
 * remaining allowance is the one that met it. The exhausted budget is what refused the unit, so a
 * provable answer is the canonical `rate_limited` refusal and no refusal AuditLogEntry commits (the
 * trigger refused that row too). A failed or inconsistent recount names no child *unless* exactly
 * one child writes audit rows at all: then the marker and the child's own statements prove the
 * attribution. Otherwise the abort stays unattributed — ADR 0029 requires the first child the unit
 * can *prove* responsible, and a misattributed refusal row would be worse evidence than none.
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
}>): Effect.Effect<Option.Option<number>> => {
  const auditWriters = children.flatMap((child, index) => (child.auditRows > 0 ? [index] : []));
  const sole = soleIndex(auditWriters);
  return Effect.tryPromise(() => dailyAuditCount({ db, userId, current })).pipe(
    Effect.map((count): Option.Option<number> => {
      let remaining = dailyAuditBudget - count;
      for (const [index, child] of children.entries()) {
        if (child.auditRows > 0 && remaining < child.auditRows) return Option.some(index);
        remaining -= child.auditRows;
      }
      return sole;
    }),
    Effect.orElseSucceed(() => sole)
  );
};

/**
 * The attribution every abort attributor can jointly prove, resolved to the *first* child any of
 * them can name: ADR 0029 reports the lowest child index the unit can prove responsible, whichever
 * kind of child owns it, so kind-grouped attributor order can never reorder children.
 */
const provenAttribution = ({
  attributors,
  cause,
  current,
  db,
  userId,
}: Readonly<{
  attributors: ReadonlyArray<AtomicAbortAttributor>;
  cause: unknown;
  current: number;
  db: D1Database;
  userId: string;
}>): Effect.Effect<Option.Option<Readonly<{ callIndex: number; refusal: AtomicUnitRefusal }>>> =>
  Effect.gen(function* () {
    let proven: Option.Option<Readonly<{ callIndex: number; refusal: AtomicUnitRefusal }>> =
      Option.none();
    for (const attributor of attributors) {
      const attributed = yield* attributor({ cause, current, db, userId }).pipe(
        Effect.orElseSucceed(() => Option.none())
      );
      if (
        Option.isSome(attributed) &&
        (Option.isNone(proven) || attributed.value.callIndex < proven.value.callIndex)
      ) {
        proven = attributed;
      }
    }
    return proven;
  });

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
      if (Option.isSome(callIndex)) {
        return {
          _tag: "Attributed",
          callIndex: callIndex.value,
          refusal: dailyAuditRefusal,
        } as const;
      }
      // The trigger refused the write but the recount cannot name the child that met it, so the
      // abort stays unattributed: ADR 0029 prefers no refusal row to a misattributed one.
      return { _tag: "Unavailable" } as const;
    }
    // Every attributor runs, resolved to the first child any of them can prove (ADR 0029), so
    // kind-grouped attributor order can never reorder children.
    const proven = yield* provenAttribution({ attributors, cause, current, db, userId });
    if (Option.isSome(proven)) {
      return {
        _tag: "Attributed",
        callIndex: proven.value.callIndex,
        refusal: proven.value.refusal,
      } as const;
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
  refusal: AtomicUnitRefusal;
}>): Effect.Effect<AtomicUnitExecution<Committed>> => {
  if (Option.isNone(child)) return Effect.succeed({ _tag: "Unavailable" } as const);
  // Only the shared budget refusal carries a trigger, and it is already the trigger's own answer.
  if ("trigger" in refusal) {
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

/** How many times the unit re-reads one child's committed records before calling them unreadable. */
const readbackAttempts = 3;

/**
 * One child's committed-record readback, retried while the read itself fails: a transient D1 read
 * defect after a successful commit must not turn a published unit into an unattributed 503 that a
 * client retry would re-commit. Only an exhausted retry is a defect; an absent row stays `None`.
 */
const committedReadback = <Committed>(
  readCommitted: Effect.Effect<Option.Option<Committed>, AtomicReadbackFailed>
): Effect.Effect<Exit.Exit<Option.Option<Committed>, AtomicReadbackFailed>> =>
  Effect.gen(function* () {
    let result = yield* Effect.exit(readCommitted);
    for (let attempt = 1; attempt < readbackAttempts && Exit.isFailure(result); attempt += 1) {
      result = yield* Effect.exit(readCommitted);
    }
    return result;
  });

/**
 * Commit one ordered set of owner-prepared canonical mutation children in a single D1 atomic unit
 * and read each child's committed records back. Every child is followed by its own completion
 * assertion, so a guard that silently changes no row aborts the whole unit instead of being noticed
 * after a successful commit. The unit never opens a nested D1 unit and never performs provider work;
 * an aborted unit is classified against the same live authority, shared budget, trigger markers,
 * and post-rollback premises the individual operations check. Attribution stops at what the unit
 * can prove: an abort that maps to no child answers the canonical unavailable failure.
 *
 * The whole unit is uninterruptible: once `db.batch` runs, the fiber must stay with the commit until
 * its outcome is classified and its committed records are read back, because stopping the wait can
 * abandon a unit that committed (ADR 0028: stopping the fiber from waiting is not the same as the
 * work not having happened).
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
  Effect.uninterruptible(
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
        const readback = yield* committedReadback(child.readCommitted);
        if (Exit.isFailure(readback)) return { _tag: "Unavailable" } as const;
        if (Option.isNone(readback.value)) return { _tag: "Unavailable" } as const;
        results.push(readback.value.value);
      }
      return { _tag: "Committed", results } as const;
    })
  );
