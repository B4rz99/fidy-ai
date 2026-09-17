import { Effect, Redacted } from "effect";
import { OutboundHttpSetupError } from "~/shell/outbound-http/contract";

export const cloudflareAccessSupportRecoveryUrl =
  "https://api.fidyapp.com/internal/support-recovery";

const bytesPerKibibyte = 1_024;
const maximumCloudflaredOutputKibibytes = 16;
const maximumCloudflaredOutputBytes = maximumCloudflaredOutputKibibytes * bytesPerKibibyte;
const cloudflaredTimeout = "30 seconds";

const unavailable = (): OutboundHttpSetupError =>
  new OutboundHttpSetupError({ reason: "unavailable" });

const readBoundedOutput = (
  stream: ReadableStream<Uint8Array>
): Effect.Effect<string, OutboundHttpSetupError> =>
  Effect.tryPromise({
    try: (signal) => {
      const reader = stream.getReader();
      const cancel = (): void => {
        reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      const decoder = new TextDecoder();
      let byteLength = 0;
      let output = "";
      const readNext = (): Promise<string> =>
        reader.read().then((item) => {
          if (item.done) return output + decoder.decode();
          byteLength += item.value.byteLength;
          if (byteLength > maximumCloudflaredOutputBytes) {
            return reader
              .cancel()
              .then(() => Promise.reject(new Error("cloudflared output exceeded its bound")));
          }
          output += decoder.decode(item.value, { stream: true });
          return readNext();
        });
      return readNext().finally(() => {
        signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      });
    },
    catch: unavailable,
  });

const terminateProcess = (process: Readonly<{ kill: () => void }>): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill();
    } catch {
      // The process may already have exited; release remains complete.
    }
  });

const runCloudflared = Effect.fn("OutboundHttp.runCloudflared")(
  (arguments_: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              Bun.spawn(["cloudflared", "access", ...arguments_], {
                stdin: "inherit",
                stdout: "pipe",
                stderr: "ignore",
              }),
            catch: unavailable,
          }),
          terminateProcess
        );
        const output = yield* readBoundedOutput(child.stdout);
        const exitCode = yield* Effect.tryPromise({
          try: () => child.exited,
          catch: unavailable,
        });
        return exitCode === 0 ? output.trim() : yield* unavailable();
      })
    ).pipe(Effect.timeout(cloudflaredTimeout), Effect.mapError(unavailable))
);

/** Acquires one short-lived Cloudflare Access token without exposing its application URL or bearer. */
export const acquireCloudflareAccessToken = Effect.fn("OutboundHttp.acquireCloudflareAccessToken")(
  function* () {
    yield* runCloudflared(["login", cloudflareAccessSupportRecoveryUrl]);
    const accessToken = yield* runCloudflared([
      "token",
      `--app=${cloudflareAccessSupportRecoveryUrl}`,
    ]);
    return accessToken.length > 0 ? Redacted.make(accessToken) : yield* unavailable();
  }
);
