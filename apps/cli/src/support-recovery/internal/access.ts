import { Effect, type PlatformError, Redacted, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { RecoveryFailure, recoveryOperatorUrl } from "../contract";

const maximumTokenBytes = 8192;
const AccessToken = Schema.String.check(
  Schema.isMaxLength(maximumTokenBytes),
  Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
);
const unavailable = (): RecoveryFailure => new RecoveryFailure({ reason: "AccessUnavailable" });

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

/** Cloudflared owns Access login; neither its JWT nor its diagnostics reach the operator terminal. */
export const authenticateAccess = Effect.gen(function* () {
  const login = yield* ChildProcess.make(
    "cloudflared",
    ["access", "login", "--quiet", recoveryOperatorUrl],
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
    ["access", "token", "--app", recoveryOperatorUrl],
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
