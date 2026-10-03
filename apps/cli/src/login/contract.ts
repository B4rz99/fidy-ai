import {
  type ClaimedPATPairing,
  StartPATPairingPayload,
  type StartedPATPairing,
} from "@fidy/server/client";
import { Data, type Effect } from "effect";
import { type CliFailure, type CredentialStore, type managementUrl } from "../credential/contract";

export const LoginRequest = StartPATPairingPayload;
export type LoginRequest = typeof LoginRequest.Type;
export type PublicProgress =
  | Readonly<{
      _tag: "ApprovalRequired";
      publicCode: StartedPATPairing["publicCode"];
      managementUrl: typeof managementUrl;
    }>
  | Readonly<{ _tag: "PollingDelayed"; retryAfterSeconds: number }>;

export class PollingDelayed extends Data.TaggedError("PollingDelayed")<{
  readonly retryAfterSeconds: number;
}> {}
export type PairingClient = Readonly<{
  start: (request: LoginRequest) => Effect.Effect<StartedPATPairing, CliFailure>;
  claim: (
    pairing: StartedPATPairing
  ) => Effect.Effect<
    | typeof ClaimedPATPairing.Type
    | Readonly<{ status: "pending_approval"; pollingIntervalSeconds: number }>,
    CliFailure | PollingDelayed
  >;
}>;
export type LoginDependencies = Readonly<{
  store: CredentialStore;
  verifyStorage: Effect.Effect<void, CliFailure>;
  pairing: PairingClient;
}>;
