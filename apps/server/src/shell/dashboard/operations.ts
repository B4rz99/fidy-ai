import { Effect, Schema } from "effect";
import { DashboardUnavailable, DashboardView } from "./contract";
import { renderDashboardView as render } from "~/shell/dashboard/internal/presentation";
import { toApiFailure as projectFailure } from "~/shell/dashboard/internal/errors";

/**
 * Publish a complete, validated view of one User's decoded facts at an explicit instant.
 * The caller supplies authorized, same-User projections with complete per-Widget totals.
 * Missing or invalid presentation facts fail closed; no partial financial answer is returned.
 */
export const renderDashboardView: typeof render = (input) =>
  render(input).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.toType(DashboardView))),
    Effect.mapError(() => new DashboardUnavailable())
  );

/** Project closed owner failures and only recovery operations the caller may invoke. */
export const toApiFailure: typeof projectFailure = (input) => projectFailure(input);
