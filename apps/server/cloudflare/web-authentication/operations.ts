import type { Effect } from "effect";
import type { WebAuthenticationRequest } from "./contract";
import { ownsPath, respond } from "./internal/protocol";

/** Recognize only owner-declared browser, PAT and private recovery paths; matching grants no authority. */
export const ownsWebAuthenticationPath = (path: string): boolean => ownsPath(path);

/**
 * Coordinate one existing authentication operation through its owner. Proof, User binding,
 * one-use consumption, session issuance and persistence remain owner-authoritative. Origin and
 * ingress policy must already have run; this private composition does not replace them.
 */
export const handleWebAuthentication = (input: WebAuthenticationRequest): Effect.Effect<Response> =>
  respond(input);
