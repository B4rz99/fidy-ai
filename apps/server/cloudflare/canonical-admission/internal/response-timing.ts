import { Duration, Effect, Option } from "effect";

export type CanonicalRequestTimings = Record<"admission" | "owner" | "standing", number>;

/** Completed phases accumulate request-local elapsed time. Failed work remains in total/other; authority, queried content and identifiers never enter headers. */
export const measureCanonicalPhase = <A, E, R>({
  work,
  phase,
  timings,
}: Readonly<{
  work: Effect.Effect<A, E, R>;
  phase: keyof CanonicalRequestTimings;
  timings: Option.Option<CanonicalRequestTimings>;
}>): Effect.Effect<A, E, R> =>
  Option.isNone(timings)
    ? work
    : work.pipe(
        Effect.timed,
        Effect.map(([duration, value]) => {
          timings.value[phase] += Duration.toMillis(duration);
          return value;
        })
      );

/** Preserve streaming and all existing headers while exposing fixed, numeric diagnostic phases. */
export const appendCanonicalTimings = ({
  response,
  duration,
  timings,
}: Readonly<{
  response: Response;
  duration: Duration.Duration;
  timings: CanonicalRequestTimings;
}>): Response => {
  const total = Duration.toMillis(duration);
  const phases = {
    "canonical-total": total,
    "canonical-admission": timings.admission,
    "canonical-owner": timings.owner,
    "canonical-standing": timings.standing,
    "canonical-other": Math.max(0, total - timings.admission - timings.owner - timings.standing),
  };
  const headers = new Headers(response.headers);
  headers.append(
    "server-timing",
    Object.entries(phases)
      .map(([name, elapsed]) => `${name};dur=${elapsed.toFixed(3)}`)
      .join(", ")
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
