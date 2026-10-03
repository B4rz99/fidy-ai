import { IssuedPAT } from "@fidy/server/client";
import { Data, type Effect, type Option, type Redacted, Schema } from "effect";

export const apiOrigin = "https://api.fidyapp.com";
export const managementUrl = "https://fidyapp.com/settings/pats";

/** Local grant facts, never a claim of current server authorization. */
export const SavedGrant = Schema.Struct({
  origin: Schema.Literal(apiOrigin),
  pat: IssuedPAT.fields.pat,
});
export type SavedGrant = typeof SavedGrant.Type;
export type Credential = Readonly<{ grant: SavedGrant; bearer: typeof IssuedPAT.Type.bearer }>;

/** Closed diagnostic projection. Raw adapter causes and input never leave their owner. */
export class CliFailure extends Data.TaggedError("CliFailure")<{
  readonly reason:
    | "InvalidInput"
    | "Cancelled"
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
    | "Expired";
}> {}

/** Native credential storage boundary; raw retrieval stays inside the credential owner. */
export type NativeSecrets = Readonly<{
  get: (name: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, CliFailure>;
  set: (name: string, value: Redacted.Redacted<string>) => Effect.Effect<void, CliFailure>;
  delete: (name: string) => Effect.Effect<void, CliFailure>;
}>;

/** One saved login. Partial persistence is a failure, not an absent or usable login. */
export type CredentialStore = Readonly<{
  load: Effect.Effect<Option.Option<Credential>, CliFailure>;
  save: (credential: Credential) => Effect.Effect<void, CliFailure>;
  clear: Effect.Effect<void, CliFailure>;
}>;
