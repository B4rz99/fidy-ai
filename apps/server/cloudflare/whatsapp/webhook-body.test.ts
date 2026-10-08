import { afterAll, expect, it } from "vitest";
import { Effect } from "effect";
import { maxWhatsAppWebhookBytes } from "../../src/shell/channels/whatsapp/contract";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { receiveWhatsAppWebhook } from "./runtime";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

// Native stream fixture: cancellation deliberately remains unsettled until after observation.
const probeOversizedBody = (
  db: D1Database
): Promise<
  Readonly<{
    observed: Response | "pending";
    cancellationStarted: boolean;
    locked: boolean;
  }>
> => {
  let cancellationStarted = false;
  const { promise: cancellation, resolve: finishCancellation } = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(new Uint8Array(maxWhatsAppWebhookBytes + 1));
    },
    cancel(): Promise<void> {
      cancellationStarted = true;
      return cancellation;
    },
  });
  const request = new Request("https://api.fidyapp.com/webhooks/kapso", { method: "POST", body });
  const response = Effect.runPromise(
    receiveWhatsAppWebhook({
      DB: db,
      BROWSER_ORIGIN: "https://app.fidyapp.com",
      KAPSO_API_KEY: "test-key",
      KAPSO_WEBHOOK_SECRET: "test-secret",
      WHATSAPP_BUSINESS_PORTFOLIO_ID: "test-portfolio",
      onAccepted: () => {
        throw new Error("Oversized bytes cannot admit work");
      },
      onHostedText: () => Promise.reject(new Error("Oversized bytes cannot admit a Turn")),
      onHostedStatus: () => Promise.reject(new Error("Oversized bytes cannot admit status")),
    })(request)
  );
  const deadline = new AbortController();
  const pending = Effect.runPromise(Effect.sleep(100).pipe(Effect.as("pending" as const)), {
    signal: deadline.signal,
  });
  return Promise.race([response, pending]).then((observed) => {
    finishCancellation();
    deadline.abort();
    return response.then(() => ({ observed, cancellationStarted, locked: body.locked }));
  });
};

it("releases an oversized webhook body without waiting for hostile cancellation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const result = yield* Effect.tryPromise(() => probeOversizedBody(db));
      expect(result.observed).not.toBe("pending");
      if (result.observed !== "pending") expect(result.observed.status).toBe(413);
      expect(result.cancellationStarted).toBe(true);
      expect(result.locked).toBe(false);
    })
  ));
