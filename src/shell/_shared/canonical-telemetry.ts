import { HttpApiMiddleware } from "effect/unstable/httpapi";

/** Observes a canonical call without changing its success, failure, interruption, or requirements. */
export class CanonicalTelemetry extends HttpApiMiddleware.Service<CanonicalTelemetry>()(
  "fidy-ai/shell/_shared/canonical-telemetry/CanonicalTelemetry"
) {}
