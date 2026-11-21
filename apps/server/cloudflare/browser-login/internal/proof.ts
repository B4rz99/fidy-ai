import { Effect, type PlatformError } from "effect";
import { Hex } from "effect/encoding";

import { digestBytes } from "../../secret-material/operations";
import { browserLoginPairingInvalidBody } from "../../../src/shell/browser-login/contract";

export const digestVerifier = (value: string): Effect.Effect<string, PlatformError.PlatformError> =>
  digestBytes(new TextEncoder().encode(value)).pipe(Effect.map(Hex.encode));

export const invalidPairing = (): Response =>
  Response.json(browserLoginPairingInvalidBody, {
    status: 400,
    headers: { "cache-control": "no-store" },
  });

export const invalidProvider = (): Response =>
  Response.json({ status: "invalid" }, { status: 400, headers: { "cache-control": "no-store" } });

export const unavailable = (): Response =>
  Response.json(
    { status: "unavailable" },
    { status: 503, headers: { "cache-control": "no-store" } }
  );
