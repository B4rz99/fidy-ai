import { Data, type Option } from "effect";
import type { OAuthAuthority, OAuthCaller } from "../../src/shell/oauth-agents/contract";
import type { PATSubject as AuthorizedPAT, PATAuthority } from "../../src/shell/tokens/contract";
import type { WebSessionAuthority } from "../../src/shell/web-session/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

export class TransactionBoundaryFailure extends Data.TaggedError("TransactionBoundaryFailure")<{
  readonly cause: unknown;
}> {}

export type TransactionSubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;

export class HostedCanonicalCaller extends Data.TaggedClass("HostedCanonical")<{
  readonly userId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly authorizedOperation: Option.Option<string>;
  readonly originTurns: OwnedStatement;
  readonly publicationOrigin: OwnedStatement;
  readonly authority: Readonly<{
    table: "hosted_turns";
    predicate: string;
    bindings: ReadonlyArray<string | number | Uint8Array>;
  }>;
}> {}

export type TransactionCaller =
  | TransactionSubject
  | AuthorizedPAT
  | OAuthCaller
  | HostedCanonicalCaller;

export type CanonicalCaller = TransactionCaller;

export const transactionNoStore = { "cache-control": "no-store" };

export const maximumTransactionInputBytes = 4096;

export const maximumTransactionGroupInputBytes = 524288;

export const missingTransactionMessage = "Transaction unavailable.";

export const pairPolicyMessage =
  "Only two different Transactions with equal Currency, exact amount, and the same direction can describe one purchase.";

export const alreadyLinkedMessage =
  "One of the Transactions is already linked to another Transaction.";

export const unlinkedPairMessage = "That exact Transaction pair is not currently linked.";

export type TransactionAuthority =
  | PATAuthority
  | WebSessionAuthority
  | OAuthAuthority
  | HostedCanonicalCaller["authority"];

export type QueryAuthority = TransactionAuthority;
