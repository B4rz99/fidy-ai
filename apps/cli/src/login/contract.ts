import {
  type ClaimedPATPairing,
  type PendingPATPairingClaim,
  StartPATPairingPayload,
  type StartedPATPairing,
} from "@fidy/server/client";
import { Data, type Effect } from "effect";
import { type CliFailure, type CredentialStore, type managementUrl } from "../credential/contract";

export const approvalPageUrl = "https://fidyapp.com/connect/cli";

export const LoginRequest = StartPATPairingPayload;
export type LoginRequest = typeof LoginRequest.Type;
export type PublicProgress =
  | Readonly<{
      _tag: "ApprovalRequired";
      publicCode: StartedPATPairing["publicCode"];
      managementUrl: typeof managementUrl;
      approvalUrl: string;
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
    | Readonly<Pick<PendingPATPairingClaim, "status" | "pollingIntervalSeconds">>,
    CliFailure | PollingDelayed
  >;
}>;
export type LoginDependencies = Readonly<{
  store: CredentialStore;
  verifyStorage: Effect.Effect<void, CliFailure>;
  pairing: PairingClient;
}>;
