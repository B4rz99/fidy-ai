import { TransactionBoundaryFailure, transactionNoStore } from "./contract";
import { DateTime } from "effect";
import { newId } from "../secret-material/operations";

export const boundaryFailure = (cause: unknown): TransactionBoundaryFailure =>
  new TransactionBoundaryFailure({ cause });

export const transactionNow = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());

export const transactionId = (): string => newId();

export const transactionUnavailable = (): Response =>
  Response.json({ status: "unavailable" }, { status: 503, headers: transactionNoStore });

export const transactionFailure = ({
  code,
  status,
  message,
}: Readonly<{
  code:
    | "unauthenticated"
    | "validation_failed"
    | "not_found"
    | "rate_limited"
    | "user_action_required";
  status: number;
  message: string;
}>): Response => {
  const error = { code, message };

  return Response.json(
    { error: code === "validation_failed" ? { ...error, fields: [] } : error, next: [] },
    { status, headers: transactionNoStore }
  );
};

export type {
  CanonicalCaller,
  TransactionSubject,
  TransactionCaller,
  QueryAuthority,
  TransactionAuthority,
} from "./contract";

export {
  TransactionBoundaryFailure,
  transactionNoStore,
  maximumTransactionInputBytes,
  maximumTransactionGroupInputBytes,
  missingTransactionMessage,
  pairPolicyMessage,
  alreadyLinkedMessage,
  unlinkedPairMessage,
} from "./contract";
