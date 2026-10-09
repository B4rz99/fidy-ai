import type {
  BrowserPairingApproval,
  BrowserPairingApprovalStatement,
  BrowserPairingStart,
  PendingBrowserPairingQuery,
  PendingBrowserPairingRequest,
  RecoveryBrowserPairingApproval,
  RecoveryBrowserPairingQuery,
} from "./contract";
import { Effect, type Option } from "effect";
import { BrowserPairingUnavailable } from "./contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

import {
  pendingPairingQuery,
  prepareProvedApproval,
  provePendingPairing,
} from "./internal/email-approval";
import {
  approvedRecoveryPairingQuery,
  pendingRecoveryPairingQuery,
  prepareRecoveryApproval,
} from "./internal/recovery-approval";

import {
  approveBrowserPairing as approve,
  redeemBrowserPairing as redeem,
  startBrowserPairing as start,
} from "./internal/pairing";

/** Create a bounded unbound pairing; disclose its private verifier only to the initiating browser. */
export const startBrowserPairing = (
  input: BrowserPairingStart
): Effect.Effect<Response, BrowserPairingUnavailable> =>
  start(input).pipe(Effect.mapError(() => new BrowserPairingUnavailable()));

/** Bind a pending pairing only to the established User proved by this authenticated channel event. */
export const approveBrowserPairing = (input: BrowserPairingApproval): Effect.Effect<Response> =>
  approve(input);

/** Authenticate the browser-private verifier and redeem the approved pairing once. */
export const redeemBrowserPairing = (
  input: Readonly<{ request: Request; db: D1Database }>
): Effect.Effect<Response> => redeem(input);

/** Check the browser-private verifier against the pending pairing and apply the bounded wrong-proof policy. */
export const provePendingBrowserPairing = (
  input: PendingBrowserPairingRequest
): Effect.Effect<Option.Option<number>, BrowserPairingUnavailable> =>
  provePendingPairing(input).pipe(Effect.mapError(() => new BrowserPairingUnavailable()));
/** Project pairingId/expiresAt only for a currently pending, unexpired and unexhausted exact pairing subject. */
export const pendingBrowserPairingQuery = (input: PendingBrowserPairingQuery): OwnedStatement =>
  pendingPairingQuery(input);
/** Bind one pairing to its proving owner's current User projection; commit together with one-time proof consumption. */
export const prepareProvedBrowserPairingApproval = (
  input: BrowserPairingApprovalStatement
): D1PreparedStatement => prepareProvedApproval(input);

/** Project only the exact pending public pairing identity and deadline for a proof-owner decision. */
export const pendingRecoveryBrowserPairingQuery = (
  input: RecoveryBrowserPairingQuery
): OwnedStatement => pendingRecoveryPairingQuery(input);

/** Project the exact ready pairing's bound User and deadline inside the same proof-consumption batch. */
export const approvedRecoveryBrowserPairingQuery = (
  input: RecoveryBrowserPairingQuery
): OwnedStatement => approvedRecoveryPairingQuery(input);

/** Bind one still-pending pairing to the proof owner's exact live User; never establish a WebSession. */
export const prepareRecoveryBrowserPairingApproval = (
  input: RecoveryBrowserPairingApproval
): D1PreparedStatement => prepareRecoveryApproval(input);
