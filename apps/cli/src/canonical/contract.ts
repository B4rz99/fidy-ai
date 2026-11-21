import type { CanonicalAllowance, TelemetryTraceId } from "@fidy/server/client";
import { type Effect, type Option, Schema, type Scope } from "effect";
import type { CliFailure, Credential, CredentialStore } from "../credential/contract";
import type { HttpClient } from "effect/http";

export type OperationResult = Readonly<{
  envelope: Schema.Json;
  failed: boolean;
  retryAfterSeconds: Option.Option<number>;
  allowance: Option.Option<CanonicalAllowance>;
  traceId: Option.Option<typeof TelemetryTraceId.Type>;
}>;

export const CanonicalRequest = Schema.Struct({
  params: Schema.optionalKey(Schema.Unknown),
  query: Schema.optionalKey(Schema.Unknown),
  payload: Schema.optionalKey(Schema.Unknown),
  headers: Schema.optionalKey(Schema.Unknown),
});

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
    captureTrace: (traceId: Option.Option<typeof TelemetryTraceId.Type>) => void;
  }>
) => Effect.Effect<CanonicalClient, never, Scope.Scope>;

export type CanonicalDependencies = Readonly<{
  store: CredentialStore;
  httpClient: HttpClient.HttpClient;
  clientFactory: CanonicalClientFactory;
  readInput: (path: string) => Effect.Effect<string, CliFailure>;
  stdout: (text: string) => Effect.Effect<void>;
  stderr: (text: string) => Effect.Effect<void>;
  json: boolean;
}>;
