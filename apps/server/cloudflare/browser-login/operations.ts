import * as proof from "./internal/proof";
import * as local from "./internal/local-pairing";
import { erasurePairingsQuery } from "./internal/erasure";
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
  samplePublicCode,
  startBrowserPairing as start,
} from "./internal/pairing";

export const startBrowserPairing = (
  input: BrowserPairingStart
): Effect.Effect<Response, BrowserPairingUnavailable> =>
  start(input).pipe(Effect.mapError(() => new BrowserPairingUnavailable()));

export const approveBrowserPairing = (input: BrowserPairingApproval): Effect.Effect<Response> =>
  approve(input);

export const redeemBrowserPairing = (
  input: Readonly<{ request: Request; db: D1Database }>
): Effect.Effect<Response> => redeem(input);

export const provePendingBrowserPairing = (
  input: PendingBrowserPairingRequest
): Effect.Effect<Option.Option<number>, BrowserPairingUnavailable> =>
  provePendingPairing(input).pipe(Effect.mapError(() => new BrowserPairingUnavailable()));

export const pendingBrowserPairingQuery = (input: PendingBrowserPairingQuery): OwnedStatement =>
  pendingPairingQuery(input);

export const prepareProvedBrowserPairingApproval = (
  input: BrowserPairingApprovalStatement
): D1PreparedStatement => prepareProvedApproval(input);

export const pendingRecoveryBrowserPairingQuery = (
  input: RecoveryBrowserPairingQuery
): OwnedStatement => pendingRecoveryPairingQuery(input);

export const approvedRecoveryBrowserPairingQuery = (
  input: RecoveryBrowserPairingQuery
): OwnedStatement => approvedRecoveryPairingQuery(input);

export const prepareRecoveryBrowserPairingApproval = (
  input: RecoveryBrowserPairingApproval
): D1PreparedStatement => prepareRecoveryApproval(input);

export const browserPairingsForErasureQuery = (userId: string): OwnedStatement =>
  erasurePairingsQuery(userId);

export const sampleBrowserLoginPublicCode: typeof samplePublicCode = () => samplePublicCode();

export const digestVerifier: typeof proof.digestVerifier = (value) => proof.digestVerifier(value);
export const invalidPairing: typeof proof.invalidPairing = () => proof.invalidPairing();
export const invalidProvider: typeof proof.invalidProvider = () => proof.invalidProvider();
export const unavailable: typeof proof.unavailable = () => proof.unavailable();
export const redeemLocalPairing: typeof local.redeemLocalPairing = (...args) =>
  local.redeemLocalPairing(...args);
export const localChannelRequest: typeof local.localChannelRequest = (...args) =>
  local.localChannelRequest(...args);
