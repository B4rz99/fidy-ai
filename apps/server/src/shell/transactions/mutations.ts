import { DateTime, Effect, Option, type Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { type Category } from "~/core/categories/model";
import { CategoryNotFound } from "~/core/categories/errors";
import { type CategoryId } from "~/core/categories/reference";
import type { CapturedInterpretationContext } from "~/core/_shared/captured-interpretation-context";
import { TransactionNotFound } from "~/core/transactions/errors";
import {
  type CreateTransactionInput,
  RestoredTransactionPair,
  type Transaction,
  type TransactionExtraction,
  type TransactionId,
  type TransactionPairInput,
  type TransactionPresentation,
  UpdateTransactionInput,
} from "~/core/transactions/model";
import { checkAlreadyOccurred } from "~/core/transactions/rules";
import {
  automaticUserDecisions,
  correctedUserDecisions,
  decideCaptureUserDecisions,
} from "~/core/transactions/user-decisions";
import { type UserId } from "~/core/identity/reference";
import { type CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import { type NotFound, type ValidationFailed } from "~/shell/_shared/errors";
import { type OperationResponse, type SuggestedOperation } from "~/shell/_shared/response";
import {
  type SuggestedOperationCaller,
  checkpointSuggestedOperations,
  suggestOperation,
} from "~/shell/_shared/suggested-operations";
import { categorizeCapture } from "~/shell/categories/categorizer";
import { toApiFailure as categoryToApiFailure } from "~/shell/categories/errors";
import { findCategory } from "~/shell/categories/repo";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { findUserInScope } from "~/shell/identity/repo";
import type { SpanDescriptor } from "~/shell/observability/protocol";
import { Telemetry } from "~/shell/observability/telemetry";
import { type TransactionApiFailure, mapTransactionFailure } from "./errors";
import {
  type NotificationEmailAttestationInput,
  type StatementLineAttestationInput,
  insertManualSourceAttestationInScope,
  insertNotificationEmailSourceAttestationInScope,
  insertStatementLineSourceAttestationInScope,
  insertTransactionInScope,
  updateTransactionInScope,
} from "./repo";
import {
  deleteTransactionAndEndLinkInScope,
  linkTransactionPairInScope,
  refreshLinkedTransactionAuthoritiesInScope,
  unlinkTransactionPairInScope,
} from "./reconciliation-repo";
import { findTransactionPresentationInScope } from "./reads";

const missingTransaction = (transactionId: TransactionId) => (): TransactionNotFound =>
  new TransactionNotFound({ transactionId });
const missingCategory = (categoryId: CategoryId) => (): CategoryNotFound =>
  new CategoryNotFound({ categoryId });

const requireKnownCategory = (
  categoryId: CategoryId,
  caller: SuggestedOperationCaller
): Effect.Effect<Category, NotFound | ValidationFailed, SqlClient.SqlClient> =>
  findCategory(categoryId).pipe(
    Effect.flatMap(Effect.fromOption(missingCategory(categoryId))),
    Effect.mapError((failure) => categoryToApiFailure({ failure, caller }))
  );

type MutationResponse<Data extends Schema.Top> = ReturnType<typeof OperationResponse<Data>>["Type"];

const captureCategory = (
  userId: UserId,
  input: CreateTransactionInput,
  caller: SuggestedOperationCaller
): Effect.Effect<CategoryId, NotFound | ValidationFailed, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const callerCategory = yield* Option.match(input.categoryId, {
      onNone: () => Effect.succeed(Option.none<CategoryId>()),
      onSome: (categoryId) =>
        requireKnownCategory(categoryId, caller).pipe(Effect.as(Option.some(categoryId))),
    });
    return yield* categorizeCapture({ userId, counterparty: input.counterparty, callerCategory });
  });

const capturedTransactionOperations = (
  caller: SuggestedOperationCaller
): ReadonlyArray<SuggestedOperation> =>
  checkpointSuggestedOperations({
    candidates: [
      suggestOperation({
        tool: "transactions.listTransactions",
        args: Option.none(),
        hint: "List transactions to see the new entry in the history.",
      }),
    ],
    caller,
  });

/** Identifies the authorized User and caller policy shared by canonical Transaction mutations. */
export type TransactionMutationContext = Readonly<{
  userId: UserId;
  caller: SuggestedOperationCaller;
}>;

/** Facts supplied after canonical decoding and caller authorization for Transaction creation. */
export type CreateTransactionMutationInput = TransactionMutationContext &
  Readonly<{
    payload: CreateTransactionInput;
  }>;

const captureTransactionSpan = {
  component: "postgres",
  operation: "postgres.repositoryOperation",
  trigger: "api",
  spanOperation: "db",
  workKind: "repository_operation",
  metadata: {
    _tag: "Database",
    system: "postgresql",
    repositoryOperation: "capture_transaction",
  },
} as const satisfies SpanDescriptor;

/** Creates a normalized Transaction and provenance inside the caller-owned transaction. */
export const createTransaction: CanonicalMutationImplementation<
  CreateTransactionMutationInput,
  MutationResponse<typeof Transaction>,
  TransactionApiFailure,
  Telemetry
> = Effect.fn("createTransaction")(function* ({
  userId,
  caller,
  payload,
}: CreateTransactionMutationInput) {
  const telemetry = yield* Telemetry;
  const now = yield* DateTime.now;
  yield* checkAlreadyOccurred({ occurredAt: payload.occurredAt, now }).pipe(
    mapTransactionFailure({ caller })
  );
  const userDecisions = yield* decideCaptureUserDecisions(payload);
  const categoryId = yield* captureCategory(userId, payload, caller);
  const input = UpdateTransactionInput.make({ ...payload, categoryId });
  const user = yield* findUserInScope(userId).pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);
  const transaction = yield* telemetry.span(
    captureTransactionSpan,
    insertTransactionInScope(userId, { facts: input, userDecisions })
  );
  yield* insertManualSourceAttestationInScope(userId, transaction.id, {
    serviceMarket: user.serviceMarket,
    locale: user.locale,
    timeZone: user.timeZone,
  });
  return { data: transaction, next: capturedTransactionOperations(caller) };
});

const captureExtractedTransactionInScope = Effect.fn("captureExtractedTransactionInScope")(
  function* (input: {
    readonly userId: UserId;
    readonly extraction: TransactionExtraction;
    readonly caller: SuggestedOperationCaller;
  }) {
    const now = yield* DateTime.now;
    yield* checkAlreadyOccurred({ occurredAt: input.extraction.occurredAt, now }).pipe(
      mapTransactionFailure({ caller: input.caller })
    );
    const categoryId = yield* categorizeCapture({
      userId: input.userId,
      counterparty: input.extraction.counterparty,
      callerCategory: Option.none(),
    });
    return yield* insertTransactionInScope(input.userId, {
      facts: UpdateTransactionInput.make({
        ...input.extraction,
        categoryId,
        notes: Option.none(),
      }),
      userDecisions: automaticUserDecisions,
    });
  }
);

/** Accepted statement facts supplied by Ingestion inside its finalization transaction. */
export type CaptureStatementTransactionInput = Readonly<{
  userId: UserId;
  extraction: TransactionExtraction;
  context: CapturedInterpretationContext;
  attestation: Omit<StatementLineAttestationInput, keyof CapturedInterpretationContext>;
  caller: SuggestedOperationCaller;
}>;

/**
 * Creates a categorized Transaction and immutable statement-line provenance without opening a
 * transaction. Ingestion owns the matching User-scoped transaction and whole-file rollback.
 */
export const captureStatementTransactionInScope = Effect.fn("captureStatementTransactionInScope")(
  function* ({
    userId,
    extraction,
    context,
    attestation,
    caller,
  }: CaptureStatementTransactionInput) {
    const transaction = yield* captureExtractedTransactionInScope({
      userId,
      extraction,
      caller,
    });
    yield* insertStatementLineSourceAttestationInScope(userId, transaction.id, {
      ...context,
      ...attestation,
    });
    return transaction;
  }
);

/** Accepted notification facts supplied by Ingestion inside its finalization transaction. */
export type CaptureNotificationEmailTransactionInput = Readonly<{
  userId: UserId;
  extraction: TransactionExtraction;
  context: CapturedInterpretationContext;
  attestation: Omit<NotificationEmailAttestationInput, keyof CapturedInterpretationContext>;
  caller: SuggestedOperationCaller;
}>;

/**
 * Creates a categorized Transaction and immutable notification-email provenance without opening a
 * transaction. Ingestion must call it inside the matching User-scoped finalization transaction and
 * owns rollback together with the receipt's fenced terminal transition.
 */
export const captureNotificationEmailTransactionInScope = Effect.fn(
  "captureNotificationEmailTransactionInScope"
)(function* ({
  userId,
  extraction,
  context,
  attestation,
  caller,
}: CaptureNotificationEmailTransactionInput) {
  const transaction = yield* captureExtractedTransactionInScope({ userId, extraction, caller });
  yield* insertNotificationEmailSourceAttestationInScope(userId, transaction.id, {
    ...context,
    ...attestation,
  });
  return transaction;
});

/** Facts supplied after canonical decoding and caller authorization for linking one exact pair. */
export type LinkTransactionsInput = TransactionMutationContext &
  Readonly<{ payload: TransactionPairInput }>;

/** Links one exact pair without opening an inner transaction. */
export const linkTransactions: CanonicalMutationImplementation<
  LinkTransactionsInput,
  MutationResponse<typeof TransactionPresentation>,
  TransactionApiFailure
> = Effect.fn("linkTransactions")(function* ({ userId, payload, caller }: LinkTransactionsInput) {
  return yield* withUserLockInScope(
    advisoryLockKey.transactionReconciliation(userId),
    Effect.gen(function* () {
      const decision = yield* linkTransactionPairInScope(userId, payload).pipe(
        mapTransactionFailure({ caller })
      );
      const presentation = yield* findTransactionPresentationInScope(
        userId,
        decision.visibleTransactionId
      ).pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);
      return {
        data: presentation,
        next: checkpointSuggestedOperations({
          candidates: [
            suggestOperation({
              tool: "transactions.unlinkTransactions",
              args: Option.some({ payload: decision.pair }),
              hint: "Unlink these Transactions if they should remain separate purchases.",
            }),
          ],
          caller,
        }),
      };
    })
  );
});

/** Facts supplied after canonical decoding and caller authorization for unlinking one exact pair. */
export type UnlinkTransactionsInput = TransactionMutationContext &
  Readonly<{ payload: TransactionPairInput }>;

/** Unlinks one exact pair and records keep-separate in the same caller-owned transaction. */
export const unlinkTransactions: CanonicalMutationImplementation<
  UnlinkTransactionsInput,
  MutationResponse<typeof RestoredTransactionPair>,
  TransactionApiFailure
> = Effect.fn("unlinkTransactions")(function* ({
  userId,
  payload,
  caller,
}: UnlinkTransactionsInput) {
  return yield* withUserLockInScope(
    advisoryLockKey.transactionReconciliation(userId),
    Effect.gen(function* () {
      const pair = yield* unlinkTransactionPairInScope(userId, payload).pipe(
        mapTransactionFailure({ caller })
      );
      const first = yield* findTransactionPresentationInScope(userId, pair.firstTransactionId).pipe(
        Effect.flatMap(Effect.fromOption),
        Effect.orDie
      );
      const second = yield* findTransactionPresentationInScope(
        userId,
        pair.secondTransactionId
      ).pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);
      if (first.presentation.kind !== "independent" || second.presentation.kind !== "independent") {
        return yield* Effect.die("Unlink did not restore two independent Transactions");
      }
      const restored = RestoredTransactionPair.make({
        firstTransaction: { ...first, presentation: { kind: "independent" } },
        secondTransaction: { ...second, presentation: { kind: "independent" } },
      });
      return {
        data: restored,
        next: checkpointSuggestedOperations({
          candidates: [
            suggestOperation({
              tool: "transactions.linkTransactions",
              args: Option.some({ payload: pair }),
              hint: "Link these Transactions again only if they describe one purchase.",
            }),
          ],
          caller,
        }),
      };
    })
  );
});

/** Facts supplied after canonical decoding and caller authorization for Transaction correction. */
export type CorrectTransactionInput = TransactionMutationContext &
  Readonly<{
    transactionId: TransactionId;
    payload: UpdateTransactionInput;
  }>;

/**
 * Corrects one Transaction without opening a transaction. The caller must run this under the
 * matching User-scoped transaction and owns rollback, including any sibling atomic mutations.
 */
export const correctTransaction: CanonicalMutationImplementation<
  CorrectTransactionInput,
  MutationResponse<typeof Transaction>,
  TransactionApiFailure
> = Effect.fn("correctTransaction")(function* ({
  userId,
  transactionId,
  payload,
  caller,
}: CorrectTransactionInput) {
  const now = yield* DateTime.now;
  yield* checkAlreadyOccurred({ occurredAt: payload.occurredAt, now }).pipe(
    mapTransactionFailure({ caller })
  );
  yield* requireKnownCategory(payload.categoryId, caller);
  return yield* withUserLockInScope(
    advisoryLockKey.transactionReconciliation(userId),
    Effect.gen(function* () {
      const transaction = yield* updateTransactionInScope(userId, transactionId, {
        facts: payload,
        userDecisions: correctedUserDecisions,
      }).pipe(
        Effect.flatMap(Effect.fromOption(missingTransaction(transactionId))),
        mapTransactionFailure({ caller })
      );
      yield* refreshLinkedTransactionAuthoritiesInScope(userId, transactionId);
      return { data: transaction, next: [] };
    })
  );
});

/** Facts supplied after canonical decoding and caller authorization for Transaction deletion. */
export type DeleteTransactionInput = TransactionMutationContext &
  Readonly<{
    transactionId: TransactionId;
  }>;

/**
 * Deletes one Transaction without opening a transaction. The caller must run this under the
 * matching User-scoped transaction and owns rollback, including any sibling atomic mutations.
 */
export const deleteTransaction: CanonicalMutationImplementation<
  DeleteTransactionInput,
  MutationResponse<typeof TransactionId>,
  TransactionApiFailure
> = Effect.fn("deleteTransaction")(function* ({
  userId,
  transactionId,
  caller,
}: DeleteTransactionInput) {
  return yield* withUserLockInScope(
    advisoryLockKey.transactionReconciliation(userId),
    Effect.gen(function* () {
      const id = yield* deleteTransactionAndEndLinkInScope(userId, transactionId).pipe(
        Effect.flatMap(Effect.fromOption(missingTransaction(transactionId))),
        mapTransactionFailure({ caller })
      );
      return { data: id, next: [] };
    })
  );
});
