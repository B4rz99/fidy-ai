import {
  Currency,
  Direction,
  Money,
  TransactionId,
  TransactionPairInput,
} from "@fidy/server/transactions-runtime";
import {
  type ReconciliationMember,
  decideTransactionLink,
  orderTransactionPair,
} from "@fidy/server/transaction-reconciliation";
import { DateTime, Effect, Option, Schema } from "effect";
import { RequestBodyPolicy, boundedJsonBody } from "../http/request-body";
import {
  ReconciliationDecisionRow,
  type TransactionAuthority,
  type TransactionBoundaryFailure,
  type TransactionCaller,
  acceptedPATStatements,
  alreadyLinkedMessage,
  boundaryFailure,
  callerAuthority,
  callerScope,
  isPATCaller,
  liveTransactionAuthority,
  maximumTransactionInputBytes,
  missingTransactionMessage,
  pairPolicyMessage,
  transactionId,
  transactionNow,
  transactionUnavailable,
  unlinkedPairMessage,
} from "./transaction-boundary";
import {
  type TransactionMutationPreparation,
  executeSingleTransactionMutation,
  failedPreparation,
  refusedPreparation,
} from "./transaction-unit";

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
  subject: TransactionCaller;
  pair: Pair;
  current: number;
}>;

/** Decode one bounded canonical pair without treating either id as authority. */
export const transactionPairInput = (request: Request): Promise<Option.Option<typeof Input.Type>> =>
  boundedJsonBody(request, policy, Input);

const candidateQuery = `SELECT retained.id, retained.amount, retained.currency,
  retained.direction, retained.created_at AS created_at,
  EXISTS (SELECT 1 FROM transaction_reconciliation_members member
    WHERE member.user_id = retained.user_id AND member.transaction_id = retained.id)
    AS already_linked
FROM transactions retained`;

const candidateFromRow = (row: MemberRow): Option.Option<Candidate> =>
  Option.map(
    Schema.decodeOption(Money)({ amount: row.amount, currency: row.currency }),
    (money) => ({
      member: {
        id: row.id,
        money,
        direction: row.direction,
        createdAt: row.created_at,
      },
      alreadyLinked: row.already_linked === 1,
    })
  );

const findCandidate = ({
  db,
  userId,
  id,
}: Readonly<{ db: D1Database; userId: string; id: string }>): Effect.Effect<
  Option.Option<Candidate>,
  TransactionBoundaryFailure
> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(`${candidateQuery} WHERE retained.user_id = ? AND retained.id = ?`)
        .bind(userId, id)
        .first(),
    catch: boundaryFailure,
  }).pipe(
    Effect.flatMap((row) =>
      Option.match(Schema.decodeUnknownOption(MemberRow)(row), {
        onNone: () => Effect.succeed(Option.none<Candidate>()),
        onSome: (decoded) => Effect.succeed(candidateFromRow(decoded)),
      })
    )
  );

const findPair = (
  work: Pick<PairWork, "db" | "subject" | "pair">
): Effect.Effect<Option.Option<readonly [Candidate, Candidate]>, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    const rows = yield* Effect.forEach(
      [work.pair.firstTransactionId, work.pair.secondTransactionId],
      (id) => findCandidate({ db: work.db, userId: work.subject.userId, id })
    );
    const [first, second] = rows;
    if (first === undefined || second === undefined) return Option.none();
    return Option.isNone(first) || Option.isNone(second)
      ? Option.none()
      : Option.some([first.value, second.value] as const);
  });

const liveAuthority = (
  work: Pick<PairWork, "db" | "subject" | "current">
): Effect.Effect<Option.Option<TransactionAuthority>, TransactionBoundaryFailure> =>
  Effect.tryPromise({
    try: () =>
      liveTransactionAuthority({
        db: work.db,
        subject: work.subject,
        current: work.current,
      }),
    catch: boundaryFailure,
  }).pipe(
    Effect.map((live) =>
      live
        ? Option.some(callerAuthority({ subject: work.subject, current: work.current }))
        : Option.none()
    )
  );

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
  if (isPATCaller(subject)) {
    return acceptedPATStatements({ db, subject, operation, current });
  }
  return [
    db
      .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
        SELECT ?, user_id, ?, ?, 'success', ? FROM transaction_reconciliation_decisions
        WHERE user_id = ? AND first_transaction_id = ? AND second_transaction_id = ?
          AND state = ? AND changes() = 1`)
      .bind(
        transactionId(),
        subject.id,
        operation,
        current,
        subject.userId,
        pair.firstTransactionId,
        pair.secondTransactionId,
        state
      ),
  ];
};

const memberInsert = (work: PairWork & Readonly<{ transactionId: string }>): D1PreparedStatement =>
  work.db
    .prepare(`INSERT INTO transaction_reconciliation_members
      (user_id, transaction_id, first_transaction_id, second_transaction_id)
      SELECT ?, ?, ?, ? WHERE changes() = 1`)
    .bind(
      work.subject.userId,
      work.transactionId,
      work.pair.firstTransactionId,
      work.pair.secondTransactionId
    );

const memberDelete = (work: PairWork & Readonly<{ transactionId: string }>): D1PreparedStatement =>
  work.db
    .prepare(`DELETE FROM transaction_reconciliation_members
      WHERE user_id = ? AND transaction_id = ? AND first_transaction_id = ? AND second_transaction_id = ?
        AND changes() = 1`)
    .bind(
      work.subject.userId,
      work.transactionId,
      work.pair.firstTransactionId,
      work.pair.secondTransactionId
    );

/**
 * The guarded writes of one link: the decision re-asserts both retained rows still exist and still
 * hold equal Currency, exact amount, and direction at commit time, then the member inserts and the
 * success Audit are chained on `changes()` so a premise that moved after the candidate read aborts
 * the whole unit.
 */
const linkStatements = (
  work: PairWork & Readonly<{ visibleTransactionId: string; authority: TransactionAuthority }>
): ReadonlyArray<D1PreparedStatement> => {
  const { db, subject, pair, current, visibleTransactionId, authority } = work;
  const decidedAt = DateTime.formatIso(DateTime.makeUnsafe(current));
  return [
    db
      .prepare(`INSERT INTO transaction_reconciliation_decisions
        (user_id, first_transaction_id, second_transaction_id, state, visible_transaction_id, decided_at)
        SELECT ?, ?, ?, 'linked', ?, ?
        WHERE EXISTS (
            SELECT 1 FROM transactions first_retained
            INNER JOIN transactions second_retained
              ON second_retained.user_id = first_retained.user_id AND second_retained.id = ?
            WHERE first_retained.user_id = ? AND first_retained.id = ?
              AND first_retained.currency = second_retained.currency
              AND first_retained.amount = second_retained.amount
              AND first_retained.direction = second_retained.direction
          )
          AND NOT EXISTS (SELECT 1 FROM transaction_reconciliation_members
            WHERE user_id = ? AND transaction_id IN (?, ?))
          AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
        ON CONFLICT (user_id, first_transaction_id, second_transaction_id) DO UPDATE SET
          state = 'linked', visible_transaction_id = excluded.visible_transaction_id,
          decided_at = excluded.decided_at`)
      .bind(
        subject.userId,
        pair.firstTransactionId,
        pair.secondTransactionId,
        visibleTransactionId,
        decidedAt,
        pair.secondTransactionId,
        subject.userId,
        pair.firstTransactionId,
        subject.userId,
        pair.firstTransactionId,
        pair.secondTransactionId,
        ...authority.bindings
      ),
    memberInsert({ ...work, transactionId: pair.firstTransactionId }),
    memberInsert({ ...work, transactionId: pair.secondTransactionId }),
    ...successStatements({ ...work, operation: "transactions.linkTransactions", state: "linked" }),
  ];
};

const unlinkStatements = (
  work: PairWork & Readonly<{ authority: TransactionAuthority }>
): ReadonlyArray<D1PreparedStatement> => {
  const { db, subject, pair, current, authority } = work;
  const decidedAt = DateTime.formatIso(DateTime.makeUnsafe(current));
  return [
    db
      .prepare(`UPDATE transaction_reconciliation_decisions
        SET state = 'keep-separate', visible_transaction_id = NULL, decided_at = ?
        WHERE user_id = ? AND first_transaction_id = ? AND second_transaction_id = ? AND state = 'linked'
          AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
      .bind(
        decidedAt,
        subject.userId,
        pair.firstTransactionId,
        pair.secondTransactionId,
        ...authority.bindings
      ),
    memberDelete({ ...work, transactionId: pair.firstTransactionId }),
    memberDelete({ ...work, transactionId: pair.secondTransactionId }),
    ...successStatements({
      ...work,
      operation: "transactions.unlinkTransactions",
      state: "keep-separate",
    }),
  ];
};

/** Decide one canonical link against live authority and both retained candidates. */
export const prepareLink = (work: PairWork): Effect.Effect<TransactionMutationPreparation> =>
  Effect.gen(function* () {
    if (work.pair.firstTransactionId === work.pair.secondTransactionId) {
      return refusedPreparation("validation_failed", samePairMessage);
    }
    const authority = yield* liveAuthority(work);
    if (Option.isNone(authority)) return { _tag: "CredentialRefused" } as const;
    const candidates = yield* findPair(work);
    if (Option.isNone(candidates)) {
      return refusedPreparation("not_found", missingTransactionMessage);
    }
    const [first, second] = candidates.value;
    if (first.alreadyLinked || second.alreadyLinked) {
      return refusedPreparation("validation_failed", alreadyLinkedMessage);
    }
    const decided = yield* decideTransactionLink(first.member, second.member).pipe(Effect.option);
    if (Option.isNone(decided)) {
      return refusedPreparation("validation_failed", pairPolicyMessage);
    }
    const decision = decided.value;
    return {
      _tag: "Prepared",
      mutation: {
        operation: "transactions.linkTransactions",
        transactionId: decision.visibleTransactionId,
        response: { _tag: "EffectiveTransaction", pair: decision.pair },
        expectedRevision: Option.none(),
        requiredScope: callerScope(work.subject),
        statements: linkStatements({
          ...work,
          pair: decision.pair,
          visibleTransactionId: decision.visibleTransactionId,
          authority: authority.value,
        }),
      },
    } as const;
  }).pipe(Effect.orElseSucceed(failedPreparation));

/** Decide one canonical unlink against live authority and the pair's current decision state. */
export const prepareUnlink = (work: PairWork): Effect.Effect<TransactionMutationPreparation> =>
  Effect.gen(function* () {
    const ordered = yield* orderTransactionPair(work.pair).pipe(Effect.option);
    if (Option.isNone(ordered)) {
      return refusedPreparation("validation_failed", samePairMessage);
    }
    const pair = ordered.value;
    const authority = yield* liveAuthority(work);
    if (Option.isNone(authority)) return { _tag: "CredentialRefused" } as const;
    const candidates = yield* findPair({ ...work, pair });
    if (Option.isNone(candidates)) {
      return refusedPreparation("not_found", missingTransactionMessage);
    }
    const decision = yield* Effect.tryPromise({
      try: () =>
        work.db
          .prepare(`SELECT state FROM transaction_reconciliation_decisions
            WHERE user_id = ? AND first_transaction_id = ? AND second_transaction_id = ?`)
          .bind(work.subject.userId, pair.firstTransactionId, pair.secondTransactionId)
          .first(),
      catch: boundaryFailure,
    });
    const state = Schema.decodeUnknownOption(ReconciliationDecisionRow)(decision);
    if (Option.isNone(state) || state.value.state !== "linked") {
      return refusedPreparation("validation_failed", unlinkedPairMessage);
    }
    return {
      _tag: "Prepared",
      mutation: {
        operation: "transactions.unlinkTransactions",
        transactionId: pair.firstTransactionId,
        response: { _tag: "RestoredPair", pair },
        expectedRevision: Option.none(),
        requiredScope: callerScope(work.subject),
        statements: unlinkStatements({ ...work, pair, authority: authority.value }),
      },
    } as const;
  }).pipe(Effect.orElseSucceed(failedPreparation));

const executePair = (
  work: Readonly<{
    db: D1Database;
    subject: TransactionCaller;
    input: Pair;
    operation: "transactions.linkTransactions" | "transactions.unlinkTransactions";
    prepare: (work: PairWork) => Effect.Effect<TransactionMutationPreparation>;
  }>
): Promise<Response> => {
  const current = transactionNow();
  return Effect.runPromise(
    Effect.gen(function* () {
      const preparation = yield* work.prepare({
        db: work.db,
        subject: work.subject,
        pair: work.input,
        current,
      });
      return yield* executeSingleTransactionMutation({
        db: work.db,
        subject: work.subject,
        current,
        operation: work.operation,
        preparation,
        status: 200,
      });
    })
  ).catch(() => transactionUnavailable());
};

/** Link one exact owned pair under live caller authority, retaining both originals and evidence. */
export const linkTransactions = (work: {
  db: D1Database;
  subject: TransactionCaller;
  input: Pair;
}): Promise<Response> =>
  executePair({ ...work, operation: "transactions.linkTransactions", prepare: prepareLink });

/** Remove one exact reversible link under live caller authority and remember keep-separate. */
export const unlinkTransactions = (work: {
  db: D1Database;
  subject: TransactionCaller;
  input: Pair;
}): Promise<Response> =>
  executePair({ ...work, operation: "transactions.unlinkTransactions", prepare: prepareUnlink });
