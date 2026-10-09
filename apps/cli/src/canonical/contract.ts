import type { CanonicalAllowance } from "@fidy/server/client";
import { type Effect, type Option, Schema, type Scope } from "effect";
import type { CliFailure, Credential, CredentialStore } from "../credential/contract";
import type { HttpClient } from "effect/http";

/** Encoded canonical envelope and bounded protocol metadata, with no raw transport values. */
export type OperationResult = Readonly<{
  envelope: Schema.Json;
  failed: boolean;
  retryAfterSeconds: Option.Option<number>;
  allowance: Option.Option<CanonicalAllowance>;
}>;

/** Request fields decoded by the selected canonical codec before generated-client encoding. */
export const CanonicalRequest = Schema.Struct({
  params: Schema.optionalKey(Schema.Unknown),
  query: Schema.optionalKey(Schema.Unknown),
  payload: Schema.optionalKey(Schema.Unknown),
  headers: Schema.optionalKey(Schema.Unknown),
});

/** Generated-client port; endpoint encoders validate each decoded request field again. */
export type CanonicalClient = Readonly<
  Record<
    string,
    Readonly<
      Record<
        string,
        (input: Required<typeof CanonicalRequest.Type>) => Effect.Effect<unknown, object>
      >
    >
  >
>;
export type CanonicalClientFactory = (
  options: Readonly<{
    httpClient: HttpClient.HttpClient;
    credential: Credential;
    captureRetry: (seconds: number) => void;
    captureAllowance: (allowance: Option.Option<CanonicalAllowance>) => void;
  }>
) => Effect.Effect<CanonicalClient, never, Scope.Scope>;

/** Process adapters; result and guidance are separate channels even in machine mode. */
export type CanonicalDependencies = Readonly<{
  store: CredentialStore;
  httpClient: HttpClient.HttpClient;
  clientFactory: CanonicalClientFactory;
  readInput: (path: string) => Effect.Effect<string, CliFailure>;
  stdout: (text: string) => Effect.Effect<void>;
  stderr: (text: string) => Effect.Effect<void>;
  json: boolean;
}>;
