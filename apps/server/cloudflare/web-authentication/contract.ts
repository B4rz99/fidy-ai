import type { Effect } from "effect";
import type { HttpClient } from "effect/http";
import type { TelemetryService } from "../../src/shell/observability/contract";

export type PublishAuthenticationWork = (kind: "emailReplacement", id: string) => void;

export type WebAuthenticationRequest = Readonly<{
  request: Request;
  db: D1Database;
  loginEmail: Effect.Effect<Response>;
  support: Effect.Effect<Response, never, HttpClient.HttpClient>;
  telemetry: TelemetryService;
  publish: PublishAuthenticationWork;
}>;
