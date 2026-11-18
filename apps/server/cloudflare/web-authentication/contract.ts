import type { Effect } from "effect";
import type { HttpClient } from "effect/http";
import type { TelemetryService } from "../../src/shell/observability/contract";

/** Identity-only acceleration after owner commit; the Core runtime retains durable publication. */
export type PublishAuthenticationWork = (
  kind: "browserPairing" | "emailReplacement",
  id: string
) => void;

/**
 * One request admitted by the public/Core boundary. Owners receive their existing native binding,
 * verify their own proof and commit their own state; this coordinator owns no persistence gateway.
 * The caller supplies the bounded telemetry and publication lifetime already owned by Core.
 */
export type WebAuthenticationRequest = Readonly<{
  request: Request;
  db: D1Database;
  support: Effect.Effect<Response, never, HttpClient.HttpClient>;
  telemetry: TelemetryService;
  publish: PublishAuthenticationWork;
}>;
