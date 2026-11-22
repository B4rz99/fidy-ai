import { StartedPATPairing } from "@fidy/server/client";
import { type Effect, Schema } from "effect";
import { type CliFailure, SavedGrant, managementUrl } from "../credential/contract";
import { type LoginDependencies, type PublicProgress } from "../login/contract";

export const ApprovalRequired = Schema.TaggedStruct("ApprovalRequired", {
  publicCode: StartedPATPairing.fields.publicCode,
  managementUrl: Schema.Literal(managementUrl),
  approvalUrl: Schema.String.check(
    Schema.isPattern(
      /^https:\/\/app\.fidyapp\.com\/connect\/cli\?cliCode=[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u
    )
  ),
});

export const PollingDelayed = Schema.TaggedStruct("PollingDelayed", {
  retryAfterSeconds: Schema.Int,
});

export const LoggedIn = Schema.TaggedStruct("LoggedIn", { grant: SavedGrant });

export const LocalStatusAbsent = Schema.TaggedStruct("LocalStatus", {
  availability: Schema.Literal("absent"),
});

export const LocalStatusAvailable = Schema.TaggedStruct("LocalStatus", {
  availability: Schema.Literal("available"),
  grant: SavedGrant,
});

export const LocalStatusExpired = Schema.TaggedStruct("LocalStatus", {
  availability: Schema.Literal("expired"),
  grant: SavedGrant,
});

export const LoggedOut = Schema.TaggedStruct("LoggedOut", {});

export const PublicOutput = Schema.Union([
  ApprovalRequired,
  PollingDelayed,
  LoggedIn,
  LocalStatusAbsent,
  LocalStatusAvailable,
  LocalStatusExpired,
  LoggedOut,
]);

export type PublicOutput = typeof PublicOutput.Type;

export type CommandDependencies = LoginDependencies &
  Readonly<{
    readLine: (question: string) => Effect.Effect<string, CliFailure>;
    emit: (output: PublicOutput | PublicProgress) => Effect.Effect<void>;
  }>;
