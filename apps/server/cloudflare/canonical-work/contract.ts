import { Data } from "effect";
import type { PATAuthority } from "@fidy/server/tokens-runtime";
import type { WebSessionAuthority } from "@fidy/server/web-session-contract";
import type { AuthorizedPAT } from "../pats/pat-authorization";

/**
 * How one decided refusal was durably handled. `"recorded"` means the refusal stands and the
 * response follows from it, whether or not the owner keeps a refusal AuditLogEntry; the other
 * values name the cause that denied the durable record instead. `recordTransactionRefusal`
 * returns it, and it is the only answer a refusal Audit row can give.
 */
export type CanonicalRefusalDisposition =
  | "recorded"
  | "credential_refused"
  | "rate_limited"
  | "unavailable";

/** A Transaction adapter dependency failure whose kind is classified and never exposed. */
export class TransactionBoundaryFailure extends Data.TaggedError("TransactionBoundaryFailure")<{
  readonly cause: unknown;
}> {}

/** Shared, request-scoped identity and safe response vocabulary for the D1 Transaction adapters. */
export type TransactionSubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;

/** The two live caller subjects that may execute Transaction work. */
export type TransactionCaller = TransactionSubject | AuthorizedPAT;

export const transactionNoStore = { "cache-control": "no-store" };

/** One canonical Transaction input is bounded by this many bytes, for every adapter that reads one. */
export const maximumTransactionInputBytes = 4096;

/** The message `transactions.getTransaction` and corrections share for an absent or foreign id. */
export const missingTransactionMessage = "Transaction unavailable.";

/** The message every adapter shares for an input that fails its canonical schema. */
export const invalidTransactionMessage = "Invalid Transaction input.";

/** The message both pair entry points share when the pair cannot describe one purchase. */
export const pairPolicyMessage =
  "Only two different Transactions with equal Currency, exact amount, and the same direction can describe one purchase.";

/** The message both pair entry points share when either member is already linked. */
export const alreadyLinkedMessage =
  "One of the Transactions is already linked to another Transaction.";

/** The message both pair entry points share when the exact pair is not currently linked. */
export const unlinkedPairMessage = "That exact Transaction pair is not currently linked.";

/** The canonical mutations this adapter executes, individually or as children of one batch. */
export type TransactionMutationOperation =
  | "transactions.createTransaction"
  | "transactions.updateTransaction"
  | "transactions.linkTransactions"
  | "transactions.unlinkTransactions";

/**
 * Why one canonical Transaction mutation was refused without changing domain state. The outcome is
 * the metadata-only rejection Audit either an individual call or a batch child reports; `message`
 * is addressed to the calling agent and never carries input bodies or database detail.
 */
export type TransactionRefusal = Readonly<{
  outcome: "not_found" | "validation_failed" | "resource_limit";
  message: string;
}>;

/** One live-authority gate over a credential table: its table, predicate, and bindings. */
export type TransactionAuthority = PATAuthority | WebSessionAuthority;

/** The canonical shared daily-write-budget refusal every owner reports. */
export const dailyAuditMessage = "The caller's daily canonical write budget is exhausted.";
