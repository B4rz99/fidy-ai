import { Effect, Option } from "effect";

export type ReviewRequestTrace = Record<string, number>;
export const reviewTraceHeader = "x-reference-review-trace";
const reviewPaths = new Set(["/ingestion/review-workspace", "/ingestion/review-workspace/context"]);

export const isReviewTraceRequest = (request: Request): boolean => {
  const url = new URL(request.url);
  return request.method === "GET" && url.hostname === "127.0.0.1" && reviewPaths.has(url.pathname);
};

export const beginReviewTrace = (request: Request): Option.Option<ReviewRequestTrace> =>
  request.headers.get(reviewTraceHeader) === "1" && isReviewTraceRequest(request)
    ? Option.some({})
    : Option.none();

export const traceReviewPhase = <A, E, R>(
  trace: Option.Option<ReviewRequestTrace>,
  name: string,
  work: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Option.isNone(trace)
    ? work
    : Effect.suspend(() => {
        const started = performance.now();
        return work.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              trace.value[name] = performance.now() - started;
            })
          )
        );
      });

export const appendReviewTrace = (
  response: Response,
  trace: Option.Option<ReviewRequestTrace>
): Response => {
  if (Option.isNone(trace)) return response;
  const headers = new Headers(response.headers);
  headers.append(
    "server-timing",
    Object.entries(trace.value)
      .map(([name, elapsed]) => `${name};dur=${elapsed.toFixed(3)}`)
      .join(", ")
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
