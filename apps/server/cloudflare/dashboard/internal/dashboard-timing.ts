import { Duration, Effect } from "effect";

const successfulStatus = 200;

type DashboardPhase = "source" | "projection" | "audit";

/** Request-local elapsed I/O phases; production clocks cannot resolve CPU-only work. */
export const makeDashboardTiming = (
  enabled: boolean
): Readonly<{
  measure: <A, E, R>(phase: DashboardPhase, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  respond: (response: Response) => Response;
}> => {
  const phases = new Map<DashboardPhase, number>();
  return {
    measure: (phase, work) =>
      enabled
        ? work.pipe(
            Effect.timed,
            Effect.map(([elapsed, value]) => {
              phases.set(phase, Duration.toMillis(elapsed));
              return value;
            })
          )
        : work,
    respond: (response) => {
      if (
        !enabled ||
        response.status !== successfulStatus ||
        !phases.has("projection") ||
        !phases.has("audit")
      ) {
        return response;
      }
      const headers = new Headers(response.headers);
      headers.append(
        "server-timing",
        [...phases]
          .map(([phase, elapsed]) => `dashboard-${phase};dur=${elapsed.toFixed(3)}`)
          .join(", ")
      );
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};
