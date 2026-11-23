import { prepareHostedBatch as prepareBatchForTurn } from "./internal/local-hosted-batch";
import { runLocalBatch as executeBatch } from "./internal/local-batch";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";

import { withStoreCapacity } from "../runtime/sqlite/operations";
import {
  rateLimited as limited,
  attachStanding as standingResponse,
  noAuthority as unauthorized,
  canonicalAdmissionUnavailable as unavailable,
} from "./internal/responses";
import {
  isNativeAccountQuery as accountQuery,
  readNativeAccountQuery as accountQueryResult,
  admitLocalRequest as admitLocal,
  externalRead,
  repairReceiptAlarm as inspectReceipts,
  localPreparationSubject as localPreparationSubjectOwned,
  runLocalMutation as mutateLocal,
  sweepReceiptWork as recoverReceipts,
  sweepLocalReceipts as sweepReceipts,
} from "./internal/local-mutation";
import {
  type CanonicalAdmissionFailure,
  type CanonicalAdmissionUnavailable,
  type CanonicalRejection,
  type CanonicalWireOutcome,
  type LocalMutationPlan,
  type LocalMutationResult,
  type LocalMutationTransaction,
  isCanonicalRejection,
} from "./contract";
import {
  encodeRejection,
  admissionFailure as normalizeAdmissionFailure,
} from "./internal/rejection";
import { Effect, Option } from "effect";
import { type QuotaStatus } from "../../src/core/quotas/contract";
import { localCanonicalArguments as readArguments } from "./internal/request-input";

export const admissionFailure = (cause: unknown): CanonicalAdmissionFailure =>
  normalizeAdmissionFailure(cause);

export const encodeLocalRejection = (rejection: CanonicalRejection): CanonicalWireOutcome =>
  encodeRejection(rejection);

export const canonicalAdmissionUnavailable = (): Response => unavailable();

export const noAuthority = (): Response => unauthorized();

export const rateLimited = (): Response => limited();

const attachStanding = (response: Response, status: QuotaStatus, current: number): Response =>
  standingResponse({ response, status, current });

export const attachCanonicalStanding = ({
  response,
  status,
  current,
}: Readonly<{ response: Response; status: QuotaStatus; current: number }>): Response =>
  attachStanding(response, status, current);

export const runLocalMutation: typeof mutateLocal = (input) => mutateLocal(input);

export const admitLocalRequest: typeof admitLocal = (input) => admitLocal(input);

export const sweepLocalReceipts: typeof sweepReceipts = (current) => sweepReceipts(current);

export const recoverLocalReceipts: typeof recoverReceipts = (current, storage) =>
  recoverReceipts(current, storage);

type LocalWrite<E> = {
  targets: ReadonlyArray<string>;
  commit: Effect.Effect<LocalMutationResult, E, SqliteClient>;
};

const localPlan = <E, Failure = never>(
  write:
    | LocalWrite<E>
    | (LocalWrite<E> & { premises: ReadonlyArray<string> })
    | (LocalWrite<E> & {
        review: Effect.Effect<{ effect: string; revision: string }, Failure, SqliteClient>;
      }),
  transaction: LocalMutationTransaction
): LocalMutationPlan => ({
  removedTarget: Option.none(),
  premises: "premises" in write ? write.premises : [],
  targets: write.targets,
  transaction,
  review:
    "review" in write
      ? Option.some(write.review.pipe(Effect.mapError(admissionFailure)))
      : Option.none(),
  commit: write.commit.pipe(Effect.mapError(admissionFailure)),
});

export const prepareLocalWrite = <E, Failure = never>(
  write:
    | LocalWrite<E>
    | (LocalWrite<E> & { premises: ReadonlyArray<string> })
    | (LocalWrite<E> & {
        review: Effect.Effect<{ effect: string; revision: string }, Failure, SqliteClient>;
      })
): LocalMutationPlan => localPlan(write, "caller");

export const prepareLocalRead = <E, Failure = never>(
  write:
    | LocalWrite<E>
    | (LocalWrite<E> & { premises: ReadonlyArray<string> })
    | (LocalWrite<E> & {
        review: Effect.Effect<{ effect: string; revision: string }, Failure, SqliteClient>;
      })
): LocalMutationPlan => localPlan(write, "none");

export const commitLocalPlan = (
  preparation: LocalMutationPlan
): Effect.Effect<LocalMutationResult, CanonicalAdmissionFailure, SqliteClient> => {
  if (preparation.transaction !== "caller") return preparation.commit;

  return Effect.gen(function* () {
    const sql = yield* SqliteClient;

    return yield* sql.withTransaction(preparation.commit).pipe(Effect.mapError(admissionFailure));
  });
};

export const settleLocalPlan = (
  preparation: LocalMutationPlan
): Effect.Effect<CanonicalWireOutcome, CanonicalAdmissionUnavailable, SqliteClient> =>
  commitLocalPlan(preparation).pipe(
    Effect.catchIf(isCanonicalRejection, (rejection) => Effect.succeed(encodeRejection(rejection)))
  );

export const runLocalBatch: typeof executeBatch = (unit, owners) => executeBatch(unit, owners);

export const localCanonicalArguments: typeof readArguments = (request, operation) =>
  readArguments(request, operation);

export const repairReceiptAlarm = Effect.fnUntraced(function* (
  current: number,
  storage: DurableObjectStorage
) {
  return yield* withStoreCapacity("required")(inspectReceipts(current, storage));
});

export const localPreparationSubject: typeof localPreparationSubjectOwned = (...args) =>
  localPreparationSubjectOwned(...args);

export const isNativeAccountQuery: typeof accountQuery = (operation) => accountQuery(operation);

export const readNativeAccountQuery: typeof accountQueryResult = (...args) =>
  accountQueryResult(...args);

export const dispatchNativeExternalRead: typeof externalRead = (input) => externalRead(input);

export const prepareHostedBatch: typeof prepareBatchForTurn = (input, context, owners) =>
  prepareBatchForTurn(input, context, owners);
