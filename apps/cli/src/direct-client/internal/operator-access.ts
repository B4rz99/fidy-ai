import { Effect, Option, type PlatformError, Redacted, Schema, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { CliFailure } from "../../credential/contract";

const maximumTokenBytes = 8192;

const AccessToken = Schema.String.check(
  Schema.isMaxLength(maximumTokenBytes),
  Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
);

const unavailable = (): CliFailure =>
  new CliFailure({ reason: "DependencyUnavailable", cause: Option.none() });

const readToken = Effect.fn(function* (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>
) {
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  yield* Stream.runForEach(stream, (chunk) =>
    Effect.gen(function* () {
      bytes += chunk.byteLength;

      if (bytes > maximumTokenBytes) return yield* unavailable();
      text += decoder.decode(chunk, { stream: true });
    })
  );
  text += decoder.decode();

  return Redacted.make(yield* Schema.decodeEffect(AccessToken)(text.trim()));
});

export const authenticateAccess = (
  operatorUrl:
    | "https://api.fidyapp.com/internal/support-recovery"
    | "https://api.fidyapp.com/internal/beta-pro"
    | "https://api.fidyapp.com/internal/sample-review"
): Effect.Effect<Redacted.Redacted<string>, CliFailure, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const login = yield* ChildProcess.make(
      "cloudflared",
      ["access", "login", "--quiet", operatorUrl],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        forceKillAfter: "1 second",
      }
    );

    if ((yield* login.exitCode) !== 0) return yield* unavailable();

    const token = yield* ChildProcess.make(
      "cloudflared",
      ["access", "token", "--app", operatorUrl],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        forceKillAfter: "1 second",
      }
    );

    const assertion = yield* readToken(token.stdout);

    if ((yield* token.exitCode) !== 0) {
      Redacted.wipeUnsafe(assertion);

      return yield* unavailable();
    }

    return assertion;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: "3 minutes", orElse: () => Effect.fail(unavailable()) }),
    Effect.mapError(unavailable)
  );
