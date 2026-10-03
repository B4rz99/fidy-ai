import { type Effect, type Option, type Schema, type Scope } from "effect";
import type { CliFailure, Credential, CredentialStore } from "../credential/contract";
import type { HttpClient } from "effect/http";

/** Encoded canonical envelope and bounded protocol metadata, with no raw transport values. */
export type OperationResult = Readonly<{
  envelope: Schema.Json;
  failed: boolean;
  retryAfterSeconds: Option.Option<number>;
}>;

/** Dynamic generated-client port. Only selected, whole-input-decoded calls may reach it. */
export type CanonicalClient = Readonly<
  Record<string, Readonly<Record<string, (input: unknown) => Effect.Effect<unknown, object>>>>
>;
export type CanonicalClientFactory = (
  options: Readonly<{
    httpClient: HttpClient.HttpClient;
    credential: Credential;
    captureRetry: (seconds: number) => void;
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
