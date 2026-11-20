import { RequestBodyPolicy } from "../http/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import { Data, Schema } from "effect";

export type BrowserPairingStart = Readonly<{ db: D1Database; retainedPairings: OwnedStatement }>;

export class BrowserPairingUnavailable extends Data.TaggedError("BrowserPairingUnavailable") {}

export type BrowserPairingApproval = Readonly<{
  db: D1Database;
  input: Readonly<{
    portfolioId: string;
    bsuid: string;
    messageId: string;
    publicCode: string;
    occurredAtMs: number;
    receivedAtMs: number;
  }>;
}>;

export type BrowserPairingClaim = Readonly<{
  consume: OwnedStatement;
  subject: OwnedStatement;
  current: number;
}>;

export type PendingBrowserPairingRequest = Readonly<{
  db: D1Database;
  pairingId: string;
  privateVerifier: string;
}>;

export type PendingBrowserPairingQuery = Readonly<{ subject: OwnedStatement; current: number }>;

export type BrowserPairingApprovalStatement = Readonly<{
  db: D1Database;
  pairingId: string;
  subject: OwnedStatement;
  current: number;
}>;

export type RecoveryBrowserPairingQuery = Readonly<{ publicCode: string; current: number }>;

export type RecoveryBrowserPairingApproval = Readonly<{
  db: D1Database;
  subject: OwnedStatement;
  current: number;
}>;

export const proofPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});
