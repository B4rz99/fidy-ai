import { Clock, Effect, Exit, Option, Schema } from "effect";
import type { OAuthConfirmationWork, OAuthNativeReview } from "../../oauth-confirmation/contract";
import { oauthReviewResponse } from "../../oauth-confirmation/operations";
import { prepareOAuthUnitConfirmation } from "./oauth-confirmation-unit";
import { maximumAtomicBatchCalls } from "../../../src/shell/operations/contract";
import type { HostedCanonicalCaller } from "../../canonical-work/contract";
import type { HostedCommitFence } from "../../agent/contract";
import { prepareHostedMutationCommit } from "../../agent/operations";
import { StatementSubmission } from "../../../src/shell/ingestion/contract";
import { EmailForwardingAddress } from "../../../src/core/ingestion/contract";
import { readForwardingAddress } from "../../ingestion/operations";
import {
  RestoredTransactionPair,
  Transaction,
  TransactionPresentation,
} from "../../../src/core/transactions/contract";
import { liveOAuthCommitAuthority } from "../../../src/shell/oauth-agents/operations";

import {
  type CanonicalRefusalDisposition,
  type TransactionCaller,
  childCaller,
  isOAuthCaller,
  liveTransactionAuthority,
  liveTransactionCredential,
  refusedCredentialResponse,
  transactionNoStore,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { findTransactionValue } from "../../transactions/operations";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
  CommittedMutationValue,
  PreparedCanonicalMutation,
} from "../contract";

const isHostedUnitCaller = (
  subject: TransactionCaller | HostedCanonicalCaller
): subject is HostedCanonicalCaller => "_tag" in subject;

/** What one caller-owned D1 unit did with its ordered canonical mutations. */
export type CanonicalMutationUnitExecution =
  | Readonly<{
      _tag: "Committed";
      /** One canonical success value per prepared mutation, in the order the unit prepared them. */
      values: ReadonlyArray<CommittedMutationValue>;
    }>
  | Readonly<{
      _tag: "Rejected";
      callIndex: number;
      refusal: CanonicalMutationRefusal;
      disposition: CanonicalRefusalDisposition;
    }>
  | Readonly<{ _tag: "CredentialRefused" }>
  | Readonly<{ _tag: "Unavailable" }>
  | Readonly<{ _tag: "Aborted" }>
  | Readonly<{ _tag: "ConfirmationReview"; review: OAuthNativeReview }>;

const commitInstant = (
  subject: TransactionCaller | HostedCanonicalCaller,
  admitted: number
): Effect.Effect<number> =>
  !isHostedUnitCaller(subject) && isOAuthCaller(subject)
    ? Clock.currentTimeMillis
    : Effect.succeed(admitted);

const childCompletion = (db: D1Database, index: number): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO canonical_child_guard (child_index, accepted)
    VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
    ON CONFLICT(child_index) DO UPDATE SET accepted = excluded.accepted`)
    .bind(index);

/** Decode only a known CHECK failure; a trigger with similar prose is not proof of a child. */
const childGuardMarker = (
  cause: unknown
): Option.Option<Readonly<{ index: number; kind: "completion" | "capacity" }>> => {
  const detail = String(cause);
  // SQLite appends the actual extended code after trigger-supplied prose. A forged CHECK phrase
  // inside a RAISE(ABORT) message still ends with SQLITE_CONSTRAINT_TRIGGER and is not trusted.
  if (detail.includes("extended: SQLITE_CONSTRAINT_TRIGGER")) return Option.none();
  const match =
    /D1_ERROR: CHECK constraint failed: canonical_child_(guard|capacity)_(0|[1-9]|10|11): SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_CHECK\)/u.exec(
      detail
    );
  if (match === null) return Option.none();
  const index = Number(match[2]);
  if (index >= maximumAtomicBatchCalls) return Option.none();
  if (match[1] === "capacity") return Option.some({ index, kind: "capacity" as const });
  return Option.some({ index, kind: "completion" as const });
};

/** Record the already-decided child refusal and return the disposition its caller must report. */
const rejectRecorded = ({
  callIndex,
  refusal,
}: Readonly<{
  callIndex: number;
  refusal: CanonicalMutationRefusal;
}>): Effect.Effect<CanonicalMutationUnitExecution> =>
  refusal.record().pipe(
    Effect.map((disposition): CanonicalMutationUnitExecution => {
      if (disposition === "credential_refused") return { _tag: "CredentialRefused" };
      if (disposition === "unavailable") return { _tag: "Unavailable" };
      return { _tag: "Rejected", callIndex, refusal, disposition };
    })
  );

/** Attribute an owner's indexed completion or capacity assertion only to the child it names. */
const refuseChildGuard = ({
  db,
  subject,
  current,
  mutations,
  index,
  kind,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
  index: number;
  kind: "completion" | "capacity";
}>): Effect.Effect<CanonicalMutationUnitExecution> =>
  Effect.gen(function* () {
    const mutation = mutations[index];
    if (mutation === undefined) return { _tag: "Unavailable" } as const;
    const scoped = childCaller({ subject, requiredScope: mutation.requiredScope });
    if (
      mutation.outcome._tag === "StatementSubmission" &&
      (yield* mutation.outcome.publication.lostReplay)
    ) {
      return { _tag: "Aborted" } as const;
    }
    const refusal = yield* mutation.guardRefusal({
      db,
      subject: scoped,
      current,
      earlier: mutations.slice(0, index).map((value) => value.outcome),
      kind,
    });
    return yield* rejectRecorded({ callIndex: index, refusal });
  });

/** Classify a child-specific CHECK, refusing unknown lookalikes without guessing a child. */
const markedAbort = ({
  db,
  subject,
  current,
  mutations,
  cause,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
  cause: unknown;
}>): Option.Option<Effect.Effect<CanonicalMutationUnitExecution>> => {
  const marker = childGuardMarker(cause);
  if (Option.isSome(marker)) {
    return Option.some(
      refuseChildGuard({
        db,
        subject,
        current,
        mutations,
        index: marker.value.index,
        kind: marker.value.kind,
      })
    );
  }
  const detail = String(cause);
  return detail.includes("canonical_child_guard_") || detail.includes("canonical_child_capacity_")
    ? Option.some(Effect.succeed({ _tag: "Unavailable" } as const))
    : Option.none();
};

/**
 * Attribute an aborted unit only when its indexed CHECK proves the child, then
 * record that child's refusal after rollback. A forged marker or unowned trigger is Unavailable;
 * an unmarked abort stays Aborted so a same-material statement can retry without a false Audit.
 */
const classifyAbortedUnit = ({
  db,
  subject,
  current,
  mutations,
  cause,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
  cause: unknown;
}>): Effect.Effect<CanonicalMutationUnitExecution> =>
  Effect.gen(function* () {
    const live = yield* Effect.tryPromise(() =>
      liveTransactionCredential({ db, subject, current })
    ).pipe(Effect.orElseSucceed(() => false));
    if (!live) return { _tag: "CredentialRefused" } as const;
    const marked = markedAbort({ db, subject, current, mutations, cause });
    if (Option.isSome(marked)) return yield* marked.value;
    return { _tag: "Aborted" } as const;
  });

/** Hosted aborts cannot be classified through a borrowed browser credential. */
const classifyUnitCallerAbort = (
  input: Omit<Parameters<typeof classifyAbortedUnit>[0], "subject"> &
    Readonly<{ subject: TransactionCaller | HostedCanonicalCaller }>
): Effect.Effect<CanonicalMutationUnitExecution> =>
  isHostedUnitCaller(input.subject)
    ? Effect.succeed({ _tag: "Unavailable" })
    : classifyAbortedUnit({ ...input, subject: input.subject });

/** Read one committed child's canonical success value, or None when the readback is incomplete. */
const findCommittedValue = ({
  db,
  userId,
  mutation,
}: Readonly<{
  db: D1Database;
  userId: string;
  mutation: PreparedCanonicalMutation;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> => {
  switch (mutation.outcome._tag) {
    case "Owner":
      return mutation.outcome.read(db, userId);
    case "Transaction":
      return findTransactionValue({ db, userId, outcome: mutation.outcome });
    case "ForwardingAddress":
      return readForwardingAddress(db, userId, mutation.outcome.current).pipe(
        Effect.map(Option.map((address) => ({ _tag: "ForwardingAddress" as const, address })))
      );
    case "StatementSubmission":
      return mutation.outcome.publication
        .readCommitted(userId)
        .pipe(
          Effect.map(
            Option.map((submission) => ({ _tag: "StatementSubmission" as const, submission }))
          )
        );
  }
};

/** OAuth rechecks execution-time grant authority without changing the hosted Turn's owner guards. */
const oauthChildStatements = ({
  db,
  subject,
  current,
  mutation,
  index,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller | HostedCanonicalCaller;
  current: number;
  mutation: PreparedCanonicalMutation;
  index: number;
}>): ReadonlyArray<D1PreparedStatement> => {
  if (isHostedUnitCaller(subject) || !isOAuthCaller(subject)) return [];
  const authority = liveOAuthCommitAuthority({
    subject: childCaller({ subject, requiredScope: mutation.requiredScope }),
    current,
  });
  return [
    db
      .prepare(`INSERT INTO canonical_child_guard (child_index, accepted)
    SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}) THEN 1 ELSE 0 END
    ON CONFLICT(child_index) DO UPDATE SET accepted = excluded.accepted`)
      .bind(index, ...authority.bindings),
  ];
};

const childStatements = ({
  db,
  subject,
  current,
  mutation,
  index,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller | HostedCanonicalCaller;
  current: number;
  mutation: PreparedCanonicalMutation;
  index: number;
}>): ReadonlyArray<D1PreparedStatement> => {
  const userId = subject.userId;
  return [
    ...oauthChildStatements({ db, subject, current, mutation, index }),
    ...Option.match(mutation.commitGuards, {
      onNone: (): ReadonlyArray<D1PreparedStatement> => [],
      onSome: (guards) => guards({ db, userId, current, index }),
    }),
    ...mutation.statements,
    childCompletion(db, index),
  ];
};

/**
 * Commit one ordered set of owner-prepared canonical mutations in a single D1 atomic unit and read
 * each committed value back. Each child has its own indexed Audit assertion and a completion assertion;
 * a guard that silently changes no row aborts the whole unit instead of being noticed after a
 * successful commit. The unit never opens a nested D1 unit and never performs provider work; an
 * aborted unit is classified against the same live credential, budgets, and domain premises the
 * individual operations check.
 */
const unitConfirmation = (
  input: Readonly<{
    db: D1Database;
    subject: TransactionCaller | HostedCanonicalCaller;
    current: number;
    mutations: ReadonlyArray<PreparedCanonicalMutation>;
    oauthConfirmation: Option.Option<OAuthConfirmationWork>;
  }>
): Effect.Effect<
  | CanonicalMutationUnitExecution
  | Readonly<{ _tag: "Continue"; statements: ReadonlyArray<D1PreparedStatement> }>
> =>
  Effect.gen(function* () {
    if (isHostedUnitCaller(input.subject) || !isOAuthCaller(input.subject)) {
      return { _tag: "Continue", statements: [] };
    }
    const prepared = yield* prepareOAuthUnitConfirmation({ ...input, subject: input.subject });
    return prepared._tag === "Refused"
      ? yield* rejectRecorded({ callIndex: prepared.index, refusal: prepared.refusal })
      : prepared;
  });

const hostedFenceStatements = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    current: number;
    fence: Option.Option<HostedCommitFence>;
  }>
): ReadonlyArray<D1PreparedStatement> =>
  Option.match(input.fence, {
    onNone: () => [],
    onSome: ({ turnId, toolCallId }) => [
      prepareHostedMutationCommit({ ...input, turnId, toolCallId }),
    ],
  });

const validUnitSize = (mutations: ReadonlyArray<PreparedCanonicalMutation>): boolean =>
  mutations.length > 0 && mutations.length <= maximumAtomicBatchCalls;

export const executeCanonicalMutationUnit = ({
  db,
  subject,
  current,
  mutations,
  hostedFence,
  oauthConfirmation,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller | HostedCanonicalCaller;
  current: number;
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
  hostedFence: Option.Option<HostedCommitFence>;
  oauthConfirmation: Option.Option<OAuthConfirmationWork>;
}>): Effect.Effect<CanonicalMutationUnitExecution> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      if (!validUnitSize(mutations)) return { _tag: "Unavailable" } as const;
      const commitCurrent = yield* commitInstant(subject, current);
      const confirmation = yield* unitConfirmation({
        db,
        subject,
        current: commitCurrent,
        mutations,
        oauthConfirmation,
      });
      if (confirmation._tag !== "Continue") return confirmation;
      const statements = [
        ...confirmation.statements,
        ...hostedFenceStatements({ db, userId: subject.userId, current, fence: hostedFence }),
        ...mutations.flatMap((mutation, index) =>
          childStatements({ db, subject, current: commitCurrent, mutation, index })
        ),
      ];
      const attempt = yield* Effect.exit(Effect.tryPromise(() => db.batch(statements)));
      if (Exit.isFailure(attempt)) {
        return yield* classifyUnitCallerAbort({
          db,
          subject,
          current: yield* commitInstant(subject, commitCurrent),
          mutations,
          cause: attempt.cause,
        });
      }
      const values: Array<CommittedMutationValue> = [];
      for (const mutation of mutations) {
        const read = findCommittedValue({ db, userId: subject.userId, mutation });
        let value = yield* read;
        for (let attempt = 1; attempt < 3 && Option.isNone(value); attempt += 1) {
          value = yield* read;
        }
        if (Option.isNone(value)) return { _tag: "Unavailable" } as const;
        values.push(value.value);
      }
      return { _tag: "Committed", values } as const;
    })
  );

const retainedMutationPayload = (
  value: Extract<
    CommittedMutationValue,
    {
      _tag: "Transaction" | "EffectiveTransaction" | "RestoredPair" | "StatementSubmission";
    }
  >
): unknown => {
  switch (value._tag) {
    case "Transaction":
    case "EffectiveTransaction":
      return value.transaction;
    case "RestoredPair":
      return value.pair;
    case "StatementSubmission":
      return value.submission;
  }
};

export const committedMutationPayload = (value: CommittedMutationValue): unknown => {
  if (value._tag === "ForwardingAddress") return value.address;
  if (value._tag === "Owner") return value.payload;
  return retainedMutationPayload(value);
};

type ExistingCommittedValue = Exclude<CommittedMutationValue, { _tag: "ForwardingAddress" }>;

const encodeEntityValue = (
  value: Exclude<
    ExistingCommittedValue,
    {
      _tag: "StatementSubmission" | "Owner";
    }
  >
): Effect.Effect<unknown, Schema.SchemaError> => {
  switch (value._tag) {
    case "Transaction":
      return Schema.encodeEffect(Schema.toCodecJson(Transaction))(value.transaction);
    case "EffectiveTransaction":
      return Schema.encodeEffect(Schema.toCodecJson(TransactionPresentation))(value.transaction);
    case "RestoredPair":
      return Schema.encodeEffect(Schema.toCodecJson(RestoredTransactionPair))(value.pair);
  }
};

const encodeExistingValue = (
  value: ExistingCommittedValue
): Effect.Effect<unknown, Schema.SchemaError> => {
  if (value._tag === "Owner") return value.encode();
  if (value._tag === "StatementSubmission") {
    return Schema.encodeEffect(Schema.toCodecJson(StatementSubmission))(value.submission);
  }
  return encodeEntityValue(value);
};

const encodeCommittedValue = (
  value: CommittedMutationValue
): Effect.Effect<unknown, Schema.SchemaError> =>
  value._tag === "ForwardingAddress"
    ? Schema.encodeEffect(Schema.toCodecJson(EmailForwardingAddress))(value.address)
    : encodeExistingValue(value);

export const committedJsonResponse = ({
  value,
  status,
}: Readonly<{ value: CommittedMutationValue; status: number }>): Effect.Effect<Response> =>
  encodeCommittedValue(value).pipe(
    Effect.map((json) =>
      Response.json({ data: json, next: [] }, { status, headers: transactionNoStore })
    ),
    Effect.orElseSucceed(transactionUnavailable)
  );

const failedPreparationResponse = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): Effect.Effect<Response> =>
  Effect.tryPromise(() => liveTransactionAuthority({ db, subject, current })).pipe(
    Effect.orElseSucceed(() => false),
    Effect.flatMap((live) =>
      live ? Effect.succeed(transactionUnavailable()) : refusedCredentialResponse({ db, subject })
    )
  );

const singleResponse = ({
  db,
  subject,
  execution,
  present,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  execution: CanonicalMutationUnitExecution;
  present: (value: CommittedMutationValue) => Effect.Effect<Response>;
}>): Effect.Effect<Response> => {
  switch (execution._tag) {
    case "Committed": {
      const [value] = execution.values;
      return value === undefined
        ? Effect.die("A committed canonical unit reported no value")
        : present(value);
    }
    case "ConfirmationReview":
      return Effect.succeed(oauthReviewResponse(execution.review));
    case "Rejected":
      return execution.refusal.respond(execution.disposition);
    case "CredentialRefused":
      return refusedCredentialResponse({ db, subject });
    case "Unavailable":
    case "Aborted":
      return Effect.succeed(transactionUnavailable());
  }
};

type SingleWork = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  preparation: CanonicalMutationPreparation;
  present: (value: CommittedMutationValue) => Effect.Effect<Response>;
  retryStatement: Option.Option<() => Effect.Effect<CanonicalMutationPreparation>>;
  hostedFence: Option.Option<HostedCommitFence>;
  oauthConfirmation: Option.Option<OAuthConfirmationWork>;
}>;

/** Commit a prepared single mutation, retrying only a proven same-material statement race. */
const executePreparedSingle = ({
  db,
  subject,
  current,
  preparation,
  present,
  retryStatement,
  hostedFence,
  oauthConfirmation,
}: SingleWork &
  Readonly<{
    preparation: Extract<CanonicalMutationPreparation, { _tag: "Prepared" }>;
  }>): Effect.Effect<Response> =>
  executeCanonicalMutationUnit({
    db,
    subject,
    current,
    mutations: [preparation.mutation],
    hostedFence,
    oauthConfirmation,
  }).pipe(
    Effect.flatMap((execution) => {
      const outcome = preparation.mutation.outcome;
      if (
        execution._tag !== "Aborted" ||
        outcome._tag !== "StatementSubmission" ||
        Option.isNone(retryStatement)
      ) {
        return singleResponse({ db, subject, execution, present });
      }
      return outcome.publication.lostReplay.pipe(
        Effect.flatMap((sameMaterial) =>
          sameMaterial
            ? retryStatement.value().pipe(
                Effect.flatMap((next) =>
                  executeSingleCanonicalMutation({
                    db,
                    subject,
                    current,
                    preparation: next,
                    present,
                    retryStatement: Option.none(),
                    hostedFence,
                    oauthConfirmation,
                  })
                )
              )
            : Effect.succeed(transactionUnavailable())
        )
      );
    })
  );

/** Execute an owner-prepared mutation in its caller-owned unit, retaining individual validation, live authority, refusal Audit and commit classification. */
export const executeSingleCanonicalMutation = ({
  db,
  subject,
  current,
  preparation,
  present,
  retryStatement,
  hostedFence,
  oauthConfirmation,
}: SingleWork): Effect.Effect<Response> => {
  switch (preparation._tag) {
    case "Refused":
      return preparation.refusal.record().pipe(Effect.flatMap(preparation.refusal.respond));
    case "CredentialRefused":
      return refusedCredentialResponse({ db, subject });
    case "Unavailable":
      return Effect.succeed(transactionUnavailable());
    case "Failed":
      return failedPreparationResponse({ db, subject, current });
    case "Prepared":
      return executePreparedSingle({
        db,
        subject,
        current,
        preparation,
        present,
        retryStatement,
        hostedFence,
        oauthConfirmation,
      });
  }
};
