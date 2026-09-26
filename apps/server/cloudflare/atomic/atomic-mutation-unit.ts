import type { CanonicalOperationId, ErrorCode } from "@fidy/server/canonical-runtime";
import { Data, Effect, Option } from "effect";
import { sharedAuditLimitRefusal } from "./daily-canonical-budget";
import { commitGuardedMutations } from "./guarded-mutation-commit";

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
 * One post-commit readback that failed instead of reporting an absent row. The unit retries it
 * after the commit, so its cause only ever distinguishes a transient read defect from a row the
 * unit can no longer prove; it is never answered directly.
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
 * silently skipped guard rolls the whole unit back instead of being noticed after commit. Every
 * prepared child writes a success AuditLogEntry inside its guarded statements.
 */
export type AtomicUnitChild<Committed> = Readonly<{
  readonly operation: CanonicalOperationId;
  readonly statements: ReadonlyArray<D1PreparedStatement>;
  readonly assertion: D1PreparedStatement;
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
  | Readonly<{ _tag: "Aborted" }>
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
      // Every child writes an audit row. A post-rollback count can race another unit, so only a
      // single-child unit can prove which child met this trigger (ADR 0029).
      const callIndex = children.length === 1 ? Option.some(0) : Option.none();
      if (Option.isSome(callIndex)) {
        return {
          _tag: "Attributed",
          callIndex: callIndex.value,
          refusal: dailyAuditRefusal,
        } as const;
      }
      // The trigger refused the write but the recount cannot name the child that met it, so the
      // abort stays unattributed: ADR 0029 prefers no refusal row to a misattributed one.
      return { _tag: "Aborted" } as const;
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
    return { _tag: "Aborted" } as const;
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
    commitGuardedMutations({ db, children }).pipe(
      Effect.flatMap((commit): Effect.Effect<AtomicUnitExecution<Committed>> =>
        commit._tag === "Aborted"
          ? classifyAborted({
              attributors,
              authority,
              cause: commit.cause,
              children,
              current,
              db,
              userId,
            })
          : Effect.succeed(
              commit._tag === "Committed"
                ? { _tag: "Committed", results: commit.values }
                : { _tag: "Unavailable" }
            )
      )
    )
  );
