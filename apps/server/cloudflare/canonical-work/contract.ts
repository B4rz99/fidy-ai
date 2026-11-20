import { Data, type Option } from "effect";
import type { OAuthAuthority, OAuthCaller } from "../../src/shell/oauth-agents/contract";
import type { PATSubject as AuthorizedPAT, PATAuthority } from "../../src/shell/tokens/contract";
import type { WebSessionAuthority } from "../../src/shell/web-session/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

export type CanonicalRefusalDisposition = "recorded" | "credential_refused" | "unavailable";

export class TransactionBoundaryFailure extends Data.TaggedError("TransactionBoundaryFailure")<{
  readonly cause: unknown;
}> {}

export type TransactionSubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;

export type HostedCanonicalCaller = Readonly<{
  _tag: "HostedCanonical";
  userId: string;
  turnId: string;
  sessionId: string;
  authorizedOperation: Option.Option<string>;
  originTurns: OwnedStatement;
  publicationOrigin: OwnedStatement;
  authority: Readonly<{
    table: "hosted_turns";
    predicate: string;
    bindings: ReadonlyArray<string | number | Uint8Array>;
  }>;
}>;

export type TransactionCaller =
  | TransactionSubject
  | AuthorizedPAT
  | OAuthCaller
  | HostedCanonicalCaller;
export type CanonicalCaller = TransactionCaller;
export type QueryCaller = TransactionCaller;

export const transactionNoStore = { "cache-control": "no-store" };

export const maximumTransactionInputBytes = 4096;
export const maximumTransactionGroupInputBytes = 524288;

export const missingTransactionMessage = "Transaction unavailable.";

export const invalidTransactionMessage = "Invalid Transaction input.";

export const pairPolicyMessage =
  "Only two different Transactions with equal Currency, exact amount, and the same direction can describe one purchase.";

export const alreadyLinkedMessage =
  "One of the Transactions is already linked to another Transaction.";

export const unlinkedPairMessage = "That exact Transaction pair is not currently linked.";

export type TransactionMutationOperation =
  | "transactions.createTransaction"
  | "transactions.updateTransaction"
  | "transactions.updateTransactions"
  | "transactions.deleteTransaction"
  | "transactions.linkTransactions"
  | "transactions.unlinkTransactions";

export type TransactionRefusal = Readonly<{
  outcome: "not_found" | "validation_failed" | "resource_limit";
  message: string;
}>;

export type TransactionAuthority =
  | PATAuthority
  | WebSessionAuthority
  | OAuthAuthority
  | HostedCanonicalCaller["authority"];
export type QueryAuthority = TransactionAuthority;
