import { afterAll, expect, it } from "vitest";
import { Effect } from "effect";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { receiveWhatsAppWebhook } from "./runtime";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

// Native ingress fixture observes rejection while the foreign cancel Promise is still pending.
const probeInterruptedBody = (
  db: D1Database
): Promise<
  Readonly<{
    observed: "response" | "interrupted" | "pending";
    cancellationStarted: boolean;
    locked: boolean;
  }>
> => {
  let cancellationStarted = false;
  const { promise: readStarted, resolve: notifyRead } = Promise.withResolvers<void>();
  const { promise: cancellation, resolve: finishCancellation } = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(): void {
        notifyRead();
      },
      cancel(): Promise<void> {
        cancellationStarted = true;
        return cancellation;
      },
    },
    { highWaterMark: 0 }
  );
  const abort = new AbortController();
  const request = new Request("https://api.fidyapp.com/webhooks/kapso", {
    method: "POST",
    body,
    signal: abort.signal,
  });
  const response = Effect.runPromise(
    receiveWhatsAppWebhook({
      DB: db,
      BROWSER_ORIGIN: "https://app.fidyapp.com",
      KAPSO_API_KEY: "test-key",
      KAPSO_WEBHOOK_SECRET: "test-secret",
      WHATSAPP_BUSINESS_PORTFOLIO_ID: "test-portfolio",
      onHostedText: () => Promise.reject(new Error("Interrupted body cannot admit a Turn")),
      onHostedStatus: () => Promise.reject(new Error("Interrupted body cannot admit status")),
    })(request),
    { signal: abort.signal }
  ).then(
    () => "response" as const,
    () => "interrupted" as const
  );
  return readStarted.then(() => {
    abort.abort();
    const deadline = new AbortController();
    const pending = Effect.runPromise(Effect.sleep(100).pipe(Effect.as("pending" as const)), {
      signal: deadline.signal,
    });
    return Promise.race([response, pending]).then((observed) => {
      finishCancellation();
      deadline.abort();
      return response.then(() => ({ observed, cancellationStarted, locked: body.locked }));
    });
  });
};

it("settles webhook interruption and releases its reader despite hostile cancellation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const result = yield* Effect.tryPromise(() => probeInterruptedBody(db));
      expect(result.observed).toBe("interrupted");
      expect(result.cancellationStarted).toBe(true);
      expect(result.locked).toBe(false);
    })
  ));
