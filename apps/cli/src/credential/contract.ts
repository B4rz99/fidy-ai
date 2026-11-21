import { IssuedPAT } from "@fidy/server/client";
import { Data, type Effect, type Option, Predicate, type Redacted, Schema } from "effect";

export const apiOrigin = "https://api.fidyapp.com";

export const managementUrl = "https://app.fidyapp.com/settings/access";

export const SavedGrant = Schema.Struct({
  origin: Schema.Literal(apiOrigin),
  pat: IssuedPAT.fields.pat,
});

export type SavedGrant = typeof SavedGrant.Type;

export type Credential = Readonly<{ grant: SavedGrant; bearer: typeof IssuedPAT.Type.bearer }>;

export class CliFailure extends Data.TaggedError("CliFailure")<{
  readonly reason:
    | "InvalidInput"
    | "Cancelled"
    | "LoginSaveInterrupted"
    | "UnsupportedRuntime"
    | "StorageUnavailable"
    | "StorageInconsistent"
    | "AlreadyLoggedIn"
    | "PairingInvalid"
    | "SourceLimited"
    | "DependencyUnavailable"
    | "TransportUnavailable"
    | "ClaimAmbiguous"
    | "ClaimStorageFailed"
    | "Expired"
    | "LoginRequired"
    | "OperationUnavailable"
    | "MutationAmbiguous"
    | "InputTooLarge";
  readonly cause: Option.Option<unknown>;
}> {}

export const isCliFailure = (value: unknown): value is CliFailure =>
  Predicate.isTagged(value, "CliFailure");

export type NativeSecrets = Readonly<{
  get: (name: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, CliFailure>;
  set: (name: string, value: Redacted.Redacted<string>) => Effect.Effect<void, CliFailure>;
  delete: (name: string) => Effect.Effect<void, CliFailure>;
}>;

export type CredentialStore = Readonly<{
  load: Effect.Effect<Option.Option<Credential>, CliFailure>;
  save: (credential: Credential) => Effect.Effect<void, CliFailure>;
  clear: Effect.Effect<void, CliFailure>;
}>;
