import * as proof from "./internal/proof";
import * as local from "./internal/local-pairing";
import { erasurePairingsQuery } from "./internal/erasure";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

import { samplePublicCode } from "./internal/pairing";

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
