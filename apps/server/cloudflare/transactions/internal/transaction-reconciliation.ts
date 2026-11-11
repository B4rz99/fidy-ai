import type { TransactionOutcome } from "../contract";
import { Currency, Money } from "../../../src/core/_shared/money";
import {
  Direction,
  type ReconciliationMember,
  TransactionId,
  TransactionPairInput,
} from "../../../src/core/transactions/contract";
import {
  decideTransactionLink,
  orderTransactionPair,
} from "../../../src/core/transactions/operations";
import { Effect, Option, Schema } from "effect";
import { prepareOwnerAuditCall } from "../../../src/shell/audit/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import {
  type CanonicalCaller,
  type TransactionAuthority,
  type TransactionBoundaryFailure,
  type TransactionRefusal,
  acceptedHostedStatement,
  acceptedOAuthStatement,
  acceptedPATStatements,
  alreadyLinkedMessage,
  boundaryFailure,
  callerAuthority,
  callerScope,
  credentialRefusedPreparation,
  failedPreparation,
  isHostedCaller,
  isOAuthCaller,
  isPATCaller,
  maximumTransactionInputBytes,
  missingTransactionMessage,
  pairPolicyMessage,
  transactionId,
  unlinkedPairMessage,
} from "../../canonical-work/operations";
import { ReconciliationDecisionRow } from "./reconciliation-state";
import { discloseTransactions, observeOAuthTransactions } from "./oauth-review";
import type { OAuthMutationReview } from "../../oauth-confirmation/contract";
import { type CanonicalMutationPreparation } from "../../canonical-operations/contract";

import { refusedTransactionMutation, transactionGuardRefusal } from "./transaction-outcome";

const Input = Schema.toCodecJson(TransactionPairInput);
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumTransactionInputBytes,
  deadlineMilliseconds: 2000,
});
const samePairMessage = "A Transaction pair needs two different Transaction ids.";

const MemberRow = Schema.Struct({
  id: TransactionId,
  amount: Schema.String,
  currency: Currency,
  direction: Direction,
  created_at: Schema.DateTimeUtcFromString,
  already_linked: Schema.Literals([0, 1]),
});
type MemberRow = typeof MemberRow.Type;
type Pair = typeof Input.Type;

/** One retained candidate as the pure link policy reads it, plus the persistence-only pair state. */
type Candidate = Readonly<{ member: ReconciliationMember; alreadyLinked: boolean }>;

type PairWork = Readonly<{
  db: D1Database;
  subject: CanonicalCaller;
  pair: Pair;
  current: number;
}>;

/** Decode one bounded canonical pair without treating either id as authority. */
export const transactionPairInput = (
  request: Request
): Effect.Effect<Option.Option<typeof Input.Type>> =>
  boundedJsonBody({ request, policy, schema: Input });

const candidateQuery = `SELECT retained.id, retained.amount, retained.currency,
  retained.direction, strftime('%Y-%m-%dT%H:%M:%fZ',retained.created_at_ms/1000.0,'unixepoch') AS created_at,
  (retained.reconciliation_first_id IS NOT NULL) AS already_linked
FROM transactions retained`;

const candidateFromRow = (row: MemberRow): Effect.Effect<Candidate, Schema.SchemaError> =>
  Schema.decodeEffect(Money)({ amount: row.amount, currency: row.currency }).pipe(
    Effect.map((money) => ({
      member: {
        id: row.id,
        money,
        direction: row.direction,
        createdAt: row.created_at,
      },
      alreadyLinked: row.already_linked === 1,
    }))
  );

const SnapshotRows = Schema.Tuple([
  Schema.Struct({
    results: Schema.Array(Schema.Struct({ authorized: Schema.Literal(1) })).check(
      Schema.isMaxLength(1)
    ),
  }),
  Schema.Struct({ results: Schema.Array(MemberRow).check(Schema.isMaxLength(2)) }),
  Schema.Struct({
    results: Schema.Array(ReconciliationDecisionRow).check(Schema.isMaxLength(1)),
  }),
]);

type PairSnapshot = Readonly<{
  authority: Option.Option<TransactionAuthority>;
  candidates: Option.Option<readonly [Candidate, Candidate]>;
  decision: Option.Option<typeof ReconciliationDecisionRow.Type>;
}>;
const pairSnapshot = (work: PairWork): Effect.Effect<PairSnapshot, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    const authority = callerAuthority({ subject: work.subject, current: work.current });
    const guard = `EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`;
    const result = yield* Effect.tryPromise({
      try: () =>
        work.db.batch([
          work.db.prepare(`SELECT 1 AS authorized WHERE ${guard}`).bind(...authority.bindings),
          work.db
            .prepare(`${candidateQuery}
          WHERE retained.user_id = ? AND retained.id IN (?, ?)
            AND retained.deleted_at_ms IS NULL AND ${guard}`)
            .bind(
              work.subject.userId,
              work.pair.firstTransactionId,
              work.pair.secondTransactionId,
              ...authority.bindings
            ),
          work.db
            .prepare(`SELECT state FROM transaction_reconciliation_decisions
          WHERE user_id = ? AND first_transaction_id = ? AND second_transaction_id = ?
            AND ${guard}`)
            .bind(
              work.subject.userId,
              work.pair.firstTransactionId,
              work.pair.secondTransactionId,
              ...authority.bindings
            ),
        ]),
      catch: boundaryFailure,
    });
    const [live, retained, decision] = yield* Schema.decodeUnknownEffect(SnapshotRows)(result).pipe(
      Effect.mapError(boundaryFailure)
    );
    const members = yield* Effect.forEach(retained.results, candidateFromRow).pipe(
      Effect.mapError(boundaryFailure)
    );
    const first = members.find((candidate) => candidate.member.id === work.pair.firstTransactionId);
    const second = members.find(
      (candidate) => candidate.member.id === work.pair.secondTransactionId
    );
    return {
      authority: live.results.length === 1 ? Option.some(authority) : Option.none(),
      candidates:
        first === undefined || second === undefined
          ? Option.none()
          : Option.some([first, second] as const),
      decision: Option.fromUndefinedOr(decision.results[0]),
    };
  });

/**
 * One successful link or unlink AuditLogEntry under the caller's own credential, guarded by the
 * decision state the write just committed. It is always the last statement of the unit.
 */
const successStatements = ({
  db,
  subject,
  operation,
  state,
  pair,
  current,
}: PairWork &
  Readonly<{
    operation: "transactions.linkTransactions" | "transactions.unlinkTransactions";
    state: "linked" | "keep-separate";
  }>): ReadonlyArray<D1PreparedStatement> => {
  if (isHostedCaller(subject)) {
    return [acceptedHostedStatement({ db, subject, operation, current })];
  }
  if (isPATCaller(subject)) {
    return acceptedPATStatements({ db, subject, operation, current });
  }
  if (isOAuthCaller(subject)) return [acceptedOAuthStatement({ db, subject, operation, current })];
  return [
    prepareOwnerAuditCall({
      db,
      id: transactionId(),
      userId: subject.userId,
      caller: { _tag: "WebSession", id: subject.id },
      operation,
      outcome: "success",
      current,
      afterOwnerWrite: true,
      when: {
        sql: "SELECT 1 FROM transaction_reconciliation_decisions WHERE user_id = ? AND first_transaction_id = ? AND second_transaction_id = ? AND state = ?",
        params: [subject.userId, pair.firstTransactionId, pair.secondTransactionId, state],
      },
    }),
  ];
};

const attachMember = (work: PairWork & Readonly<{ transactionId: string }>): D1PreparedStatement =>
  work.db
    .prepare(`UPDATE transactions SET reconciliation_first_id=?3,reconciliation_second_id=?4
      WHERE user_id=?1 AND id=?2 AND reconciliation_first_id IS NULL AND changes()=1`)
    .bind(
      work.subject.userId,
      work.transactionId,
      work.pair.firstTransactionId,
      work.pair.secondTransactionId
    );

const detachMember = (work: PairWork & Readonly<{ transactionId: string }>): D1PreparedStatement =>
  work.db
    .prepare(`UPDATE transactions SET reconciliation_row_ref=NULL,reconciliation_first_id=NULL,reconciliation_second_id=NULL WHERE reconciliation_first_id IS NOT NULL AND user_id = ? AND id = ? AND reconciliation_first_id = ? AND reconciliation_second_id = ?
        AND changes() = 1`)
    .bind(
      work.subject.userId,
      work.transactionId,
      work.pair.firstTransactionId,
      work.pair.secondTransactionId
    );

/**
 * The guarded writes of one link: the decision re-asserts both retained rows still exist and still
 * hold equal Currency, exact amount, and direction at commit time, then both member updates and the
 * success Audit are chained on `changes()` so a premise that moved after the candidate read aborts
 * the whole unit.
 */
const linkStatements = (
  work: PairWork & Readonly<{ visibleTransactionId: string; authority: TransactionAuthority }>
): ReadonlyArray<D1PreparedStatement> => {
  const { db, subject, pair, current, visibleTransactionId, authority } = work;
  const decidedAt = current;
  return [
    db
      .prepare(`INSERT INTO transaction_reconciliation_decisions
        (user_id, first_transaction_id, second_transaction_id, state, visible_transaction_id, decided_at_ms)
        SELECT ?, ?, ?, 'linked', ?, ?
        WHERE EXISTS (
            SELECT 1 FROM transactions first_retained
            INNER JOIN transactions second_retained
              ON second_retained.user_id = first_retained.user_id AND second_retained.id = ?
            WHERE first_retained.user_id = ? AND first_retained.id = ?
              AND first_retained.currency = second_retained.currency
              AND first_retained.amount = second_retained.amount
              AND first_retained.direction = second_retained.direction
              AND first_retained.reconciliation_first_id IS NULL
              AND second_retained.reconciliation_first_id IS NULL
          )
          AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
        ON CONFLICT (user_id, first_transaction_id, second_transaction_id) DO UPDATE SET
          state = 'linked', visible_transaction_id = excluded.visible_transaction_id,
          decided_at_ms = excluded.decided_at_ms`)
      .bind(
        subject.userId,
        pair.firstTransactionId,
        pair.secondTransactionId,
        visibleTransactionId,
        decidedAt,
        pair.secondTransactionId,
        subject.userId,
        pair.firstTransactionId,
        ...authority.bindings
      ),
    attachMember({ ...work, transactionId: pair.firstTransactionId }),
    attachMember({ ...work, transactionId: pair.secondTransactionId }),
    ...successStatements({ ...work, operation: "transactions.linkTransactions", state: "linked" }),
  ];
};

const unlinkStatements = (
  work: PairWork & Readonly<{ authority: TransactionAuthority }>
): ReadonlyArray<D1PreparedStatement> => {
  const { db, subject, pair, current, authority } = work;
  const decidedAt = current;
  return [
    db
      .prepare(`UPDATE transaction_reconciliation_decisions
        SET state = 'keep-separate', visible_transaction_id = NULL, decided_at_ms = ?
        WHERE user_id = ? AND first_transaction_id = ? AND second_transaction_id = ? AND state = 'linked'
          AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
      .bind(
        decidedAt,
        subject.userId,
        pair.firstTransactionId,
        pair.secondTransactionId,
        ...authority.bindings
      ),
    detachMember({ ...work, transactionId: pair.firstTransactionId }),
    detachMember({ ...work, transactionId: pair.secondTransactionId }),
    ...successStatements({
      ...work,
      operation: "transactions.unlinkTransactions",
      state: "keep-separate",
    }),
  ];
};

/** Decide one canonical link against live authority and both retained candidates. */
export const prepareLink = (work: PairWork): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const refuse = (refusal: TransactionRefusal): CanonicalMutationPreparation =>
      refusedTransactionMutation({
        db: work.db,
        subject: work.subject,
        operation: "transactions.linkTransactions",
        refusal,
        current: work.current,
      });
    if (work.pair.firstTransactionId === work.pair.secondTransactionId) {
      return refuse({ outcome: "validation_failed", message: samePairMessage });
    }
    const { authority, candidates } = yield* pairSnapshot(work);
    if (Option.isNone(authority)) return credentialRefusedPreparation();
    if (Option.isNone(candidates)) {
      return refuse({ outcome: "not_found", message: missingTransactionMessage });
    }
    const [first, second] = candidates.value;
    if (first.alreadyLinked || second.alreadyLinked) {
      return refuse({ outcome: "validation_failed", message: alreadyLinkedMessage });
    }
    const decided = yield* decideTransactionLink(first.member, second.member).pipe(Effect.option);
    if (Option.isNone(decided)) {
      return refuse({ outcome: "validation_failed", message: pairPolicyMessage });
    }
    const decision = decided.value;
    const outcome: TransactionOutcome = {
      _tag: "Transaction",
      operation: "transactions.linkTransactions",
      transactionId: decision.visibleTransactionId,
      readback: { _tag: "EffectiveTransaction", pair: decision.pair },
      expectedRevision: Option.none(),
    };
    return {
      _tag: "Prepared",
      mutation: {
        requiredScope: callerScope(work.subject),
        guardRefusal: transactionGuardRefusal(outcome),

        commitGuards: Option.none(),
        outcome,
        oauthReview: Option.none(),
        statements: linkStatements({
          ...work,
          pair: decision.pair,
          visibleTransactionId: decision.visibleTransactionId,
          authority: authority.value,
        }),
      },
    } as const;
  }).pipe(Effect.orElseSucceed(failedPreparation));

const reviewUnlink = (
  work: PairWork
): Effect.Effect<
  Option.Option<OAuthMutationReview>,
  TransactionBoundaryFailure | Schema.SchemaError
> =>
  Effect.gen(function* () {
    if (!isOAuthCaller(work.subject)) return Option.none();
    const pair = work.pair;
    const snapshot = yield* observeOAuthTransactions({
      db: work.db,
      userId: work.subject.userId,
      firstId: pair.firstTransactionId,
      secondId: pair.secondTransactionId,
    });
    const linked = snapshot.decisions.find(
      (decision) =>
        decision.first_transaction_id === pair.firstTransactionId &&
        decision.second_transaction_id === pair.secondTransactionId &&
        decision.state === "linked"
    );
    const members = snapshot.members.filter(
      (member) =>
        member.first_transaction_id === pair.firstTransactionId &&
        member.second_transaction_id === pair.secondTransactionId
    );
    if (
      linked === undefined ||
      members.length !== 2 ||
      snapshot.retained.length !== 2 ||
      snapshot.effective.length !== 1
    ) {
      return yield* boundaryFailure("changed_reconciliation_snapshot");
    }
    return snapshot.review(
      `Desvincular la Reconciliación entre ${pair.firstTransactionId} y ${pair.secondTransactionId}. ` +
        `Transacción efectiva antes: ${discloseTransactions(snapshot.effective)}. ` +
        `Transacciones independientes después: ${discloseTransactions(snapshot.retained)}. ` +
        "Se conservan ambos originales y sus SourceAttestations; la decisión cambia a mantener separadas."
    );
  });

/** Decide one canonical unlink against live authority and the pair's current decision state. */
export const prepareUnlink = (work: PairWork): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const refuse = (refusal: TransactionRefusal): CanonicalMutationPreparation =>
      refusedTransactionMutation({
        db: work.db,
        subject: work.subject,
        operation: "transactions.unlinkTransactions",
        refusal,
        current: work.current,
      });
    const ordered = yield* orderTransactionPair(work.pair).pipe(Effect.option);
    if (Option.isNone(ordered)) {
      return refuse({ outcome: "validation_failed", message: samePairMessage });
    }
    const pair = ordered.value;
    const { authority, candidates, decision: state } = yield* pairSnapshot({ ...work, pair });
    if (Option.isNone(authority)) return credentialRefusedPreparation();
    if (Option.isNone(candidates)) {
      return refuse({ outcome: "not_found", message: missingTransactionMessage });
    }
    if (Option.isNone(state) || state.value.state !== "linked") {
      return refuse({ outcome: "validation_failed", message: unlinkedPairMessage });
    }
    const oauthReview = yield* reviewUnlink({ ...work, pair });
    const outcome: TransactionOutcome = {
      _tag: "Transaction",
      operation: "transactions.unlinkTransactions",
      transactionId: pair.firstTransactionId,
      readback: { _tag: "RestoredPair", pair },
      expectedRevision: Option.none(),
    };
    return {
      _tag: "Prepared",
      mutation: {
        requiredScope: callerScope(work.subject),
        guardRefusal: transactionGuardRefusal(outcome),

        commitGuards: Option.none(),
        outcome,
        oauthReview,
        statements: unlinkStatements({ ...work, pair, authority: authority.value }),
      },
    } as const;
  }).pipe(Effect.orElseSucceed(failedPreparation));
