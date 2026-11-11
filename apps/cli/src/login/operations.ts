import { type StartedPATPairing, patPairingLifetime } from "@fidy/server/client";
import { DateTime, Duration, Effect, Option, Schema } from "effect";
import { CliFailure, type SavedGrant, apiOrigin, managementUrl } from "../credential/contract";
import {
  type LoginDependencies,
  LoginRequest,
  type PublicProgress,
  approvalPageUrl,
} from "./contract";

const requestDeadlineMilliseconds = 15_000;
const maximumLoginMilliseconds =
  Duration.toMillis(patPairingLifetime) + requestDeadlineMilliseconds;

const preparePairing = Effect.fn(function* (input: unknown, dependencies: LoginDependencies) {
  const request = yield* Schema.decodeUnknownEffect(LoginRequest, {
    errors: "all",
    onExcessProperty: "error",
  })(input).pipe(Effect.mapError(() => new CliFailure({ reason: "InvalidInput" })));
  yield* dependencies.verifyStorage;
  const existing = yield* dependencies.store.load;
  if (Option.isSome(existing)) return yield* new CliFailure({ reason: "AlreadyLoggedIn" });
  return yield* dependencies.pairing.start(request);
});

type LoginInterruption = { reason: CliFailure["reason"] };
const completeLogin = Effect.fn(function* (
  input: unknown,
  progress: (event: PublicProgress) => Effect.Effect<void>,
  options: Readonly<{ dependencies: LoginDependencies; interruption: LoginInterruption }>
) {
  const { dependencies, interruption } = options;
  const pairing = yield* preparePairing(input, dependencies);
  yield* progress(approvalProgress(pairing.publicCode));
  let delaySeconds: number = pairing.pollingIntervalSeconds;
  let remaining = pairing.expiresAt.epochMilliseconds - (yield* DateTime.now).epochMilliseconds;
  while (remaining > 0) {
    const millisecondsPerSecond = 1000;
    yield* Effect.sleep(
      Math.min(delaySeconds * millisecondsPerSecond, remaining, maximumLoginMilliseconds)
    );
    const attemptAt = yield* DateTime.now;
    if (attemptAt.epochMilliseconds >= pairing.expiresAt.epochMilliseconds) {
      return yield* new CliFailure({ reason: "Expired" });
    }
    interruption.reason = "ClaimAmbiguous";
    const result = yield* dependencies.pairing.claim(pairing).pipe(
      Effect.catchTag("PollingDelayed", (failure) =>
        progress({
          _tag: "PollingDelayed",
          retryAfterSeconds: Math.max(delaySeconds, failure.retryAfterSeconds),
        }).pipe(Effect.as(failure))
      ),
      Effect.timeoutOrElse({
        duration: Math.min(
          pairing.expiresAt.epochMilliseconds - attemptAt.epochMilliseconds,
          requestDeadlineMilliseconds
        ),
        orElse: () => Effect.fail(new CliFailure({ reason: "ClaimAmbiguous" })),
      })
    );
    remaining = pairing.expiresAt.epochMilliseconds - (yield* DateTime.now).epochMilliseconds;
    if ("_tag" in result) {
      delaySeconds = Math.max(delaySeconds, result.retryAfterSeconds);
      continue;
    }
    if ("status" in result) {
      delaySeconds = result.pollingIntervalSeconds;
      continue;
    }
    const grant: SavedGrant = { origin: apiOrigin, pat: result.pat };
    interruption.reason = "LoginSaveInterrupted";
    yield* dependencies.store.save({ grant, bearer: result.bearer }).pipe(
      Effect.mapError(() => new CliFailure({ reason: "ClaimStorageFailed" })),
      Effect.uninterruptible
    );
    return grant;
  }
  return yield* new CliFailure({ reason: "Expired" });
});

/** Owns one non-resumable pairing. Only public progress and persisted safe grant facts escape. */
export const login = Effect.fn(
  (
    input: unknown,
    progress: (event: PublicProgress) => Effect.Effect<void>,
    dependencies: LoginDependencies
  ) =>
    Effect.suspend(() => {
      const interruption: LoginInterruption = { reason: "Cancelled" };
      return completeLogin(input, progress, { dependencies, interruption }).pipe(
        Effect.timeoutOrElse({
          duration: maximumLoginMilliseconds,
          orElse: () => Effect.fail(new CliFailure({ reason: "ClaimAmbiguous" })),
        }),
        Effect.onInterrupt(() => Effect.fail(new CliFailure({ reason: interruption.reason })))
      );
    })
);

/** Carries only the public identity to the fixed first-party approval page. */
const approvalUrl = (publicCode: StartedPATPairing["publicCode"]): string =>
  `${approvalPageUrl}?cliCode=${encodeURIComponent(publicCode)}`;

const approvalProgress = (publicCode: StartedPATPairing["publicCode"]): PublicProgress => ({
  _tag: "ApprovalRequired",
  publicCode,
  managementUrl,
  approvalUrl: approvalUrl(publicCode),
});
