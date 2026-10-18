import { Data, Effect } from "effect";
import type { SmokeFailureStage } from "../contract";

/** Convert only platform Promises; their causes never cross the public smoke response. */
export class SmokeBindingFailed extends Data.TaggedError("SmokeBindingFailed")<{
  stage: SmokeFailureStage;
}> {}

// https://developers.cloudflare.com/d1/observability/debug-d1/#list-of-d1_errors
const quotaMessages = new Set([
  "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details.",
  "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details.",
  "Your account has exceeded D1's free tier daily row read limit.",
  "Your account has exceeded D1's free tier daily row write limit.",
  "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",
  "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",
]);
/** Recognize only the provider's closed daily-limit messages, including its native cause. */
const dailyQuota = (cause: unknown, depth = 0): boolean => {
  if (!(cause instanceof Error) || depth > 3) return false;
  return (
    quotaMessages.has(cause.message.replace(/^D1_ERROR: /u, "")) ||
    dailyQuota(cause.cause, depth + 1)
  );
};

export const platform = <A>({
  tryWork,
  stage,
}: Readonly<{ tryWork: () => Promise<A>; stage: SmokeFailureStage }>): Effect.Effect<
  A,
  SmokeBindingFailed
> =>
  Effect.tryPromise({
    try: tryWork,
    catch: (cause) =>
      new SmokeBindingFailed({
        stage:
          ["admission", "claim", "probe_read", "schema"].includes(stage) && dailyQuota(cause)
            ? "d1_quota"
            : stage,
      }),
  });
