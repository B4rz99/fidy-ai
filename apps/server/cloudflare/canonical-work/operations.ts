import { TransactionBoundaryFailure, transactionNoStore } from "./contract";
import { Clock, Effect } from "effect";
import { newId } from "../secret-material/operations";

export const boundaryFailure = (cause: unknown): TransactionBoundaryFailure =>
  new TransactionBoundaryFailure({ cause });

export const transactionNow = (): number => Effect.runSync(Clock.currentTimeMillis);

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
}>): Response =>
  Response.json(
    { error: { code, message, ...(code === "validation_failed" ? { fields: [] } : {}) }, next: [] },
    { status, headers: transactionNoStore }
  );

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
