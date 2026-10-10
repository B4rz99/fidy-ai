import { StartedPATPairing } from "@fidy/server/client";
import { type Effect, Schema } from "effect";
import { type CliFailure, SavedGrant, managementUrl } from "../credential/contract";
import { type LoginDependencies, type PublicProgress } from "../login/contract";

export const PublicOutput = Schema.Union([
  Schema.TaggedStruct("ApprovalRequired", {
    publicCode: StartedPATPairing.fields.publicCode,
    managementUrl: Schema.Literal(managementUrl),
    approvalUrl: Schema.String.check(
      Schema.isPattern(
        /^https:\/\/fidyapp\.com\/connect\/cli\?cliCode=[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u
      )
    ),
  }),
  Schema.TaggedStruct("PollingDelayed", { retryAfterSeconds: Schema.Int }),
  Schema.TaggedStruct("LoggedIn", { grant: SavedGrant }),
  Schema.TaggedStruct("LocalStatus", { availability: Schema.Literal("absent") }),
  Schema.TaggedStruct("LocalStatus", {
    availability: Schema.Literal("available"),
    grant: SavedGrant,
  }),
  Schema.TaggedStruct("LocalStatus", {
    availability: Schema.Literal("expired"),
    grant: SavedGrant,
  }),
  Schema.TaggedStruct("LoggedOut", {}),
]);
export type PublicOutput = typeof PublicOutput.Type;
export type CommandDependencies = LoginDependencies &
  Readonly<{
    readLine: (question: string) => Effect.Effect<string, CliFailure>;
    emit: (output: PublicOutput | PublicProgress) => Effect.Effect<void>;
  }>;
