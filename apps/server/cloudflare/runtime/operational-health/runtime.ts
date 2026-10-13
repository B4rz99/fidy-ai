import {
  ResendAccepted,
  makeOperatorEmailClient,
  operatorEmailBody,
  redirectStatus,
  successStatus,
} from "./internal/operator-email";
import { Effect, Result, Schema } from "effect";
import type { CoreRejectionBoundary, OperationalAlert } from "./contract";

/** Sends only closed operator metadata over the existing bounded Resend transport. */
export const sendOperatorEmail = (
  input: Readonly<{
    alert: OperationalAlert;
    idempotencyKey: string;
    to: string;
    apiKey: string;
    release: string;
    phase: "firing" | "resolved";
    signal: AbortSignal;
  }>
): Promise<void> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const outbound = yield* makeOperatorEmailClient(input);
        const body = yield* operatorEmailBody(input);
        return yield* outbound.execute({
          _tag: "ResendEmailDelivery",
          idempotencyKey: input.idempotencyKey,
          body,
        });
      })
    ),
    { signal: input.signal }
  ).then((result): void => {
    if (result._tag === "Failure") throw new Error("Operator email delivery unavailable");
    const response = result.value;
    if (
      response.status < successStatus ||
      response.status >= redirectStatus ||
      Result.isFailure(
        Schema.decodeResult(Schema.fromJsonString(ResendAccepted))(
          new TextDecoder().decode(response.body)
        )
      )
    ) {
      throw new Error("Operator email delivery unavailable");
    }
  });

const minuteMs = 60_000;
const burstThreshold = 100;
const unauthorizedStatus = 401;
const forbiddenStatus = 403;
const badRequestStatus = 400;
const unprocessableStatus = 422;
const serverErrorStatus = 500;
const observedRefusal = (boundary: CoreRejectionBoundary, status: number): boolean => {
  if (status === unauthorizedStatus || status === forbiddenStatus) return true;
  if (boundary === "providerCallback") {
    return status === badRequestStatus || status === unprocessableStatus;
  }
  return boundary === "mcp" && status >= badRequestStatus && status < serverErrorStatus;
};

/**
 * Records concentrated refusal bursts without retaining request metadata. One observer belongs to
 * one Core HTTP assembly or MCP residency. It is deliberately lossy across restarts and
 * distributed traffic; all observers share one metadata-only presence row.
 */
export const makeCoreRejectionObserver = (): ((
  input: Readonly<{
    status: number;
    boundary: CoreRejectionBoundary;
    db: D1Database;
    now: number;
  }>
) => Effect.Effect<void>) => {
  let minute = -1;
  let refusals = 0;
  let pending = false;
  return ({ status, boundary, db, now }) =>
    Effect.suspend(() => {
      if (!observedRefusal(boundary, status)) return Effect.void;
      const observedAtMs = Math.floor(now / minuteMs) * minuteMs;
      // A clock rollback never reopens an already admitted minute.
      if (observedAtMs < minute) return Effect.void;
      if (observedAtMs > minute) {
        minute = observedAtMs;
        refusals = 0;
      }
      if (refusals >= burstThreshold) return Effect.void;
      refusals += 1;
      if (refusals < burstThreshold || pending) return Effect.void;
      pending = true;
      return Effect.tryPromise(() =>
        Promise.resolve()
          .then(() =>
            db
              .prepare(`INSERT INTO operational_core_rejection_burst (id, observed_at_ms)
          VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET observed_at_ms = excluded.observed_at_ms
          WHERE excluded.observed_at_ms > observed_at_ms`)
              .bind(observedAtMs)
              .run()
          )
          .finally(() => {
            // D1 has no cancellation API: retain this guard until the actual promise settles.
            pending = false;
          })
      ).pipe(
        Effect.timeout("250 millis"),
        Effect.orElseSucceed(() => undefined)
      );
    });
};
