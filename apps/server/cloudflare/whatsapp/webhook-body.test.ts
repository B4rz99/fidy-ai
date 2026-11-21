import { assert, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import { maxWhatsAppWebhookBytes } from "../../src/shell/channels/whatsapp/contract";
import { receiveWhatsAppWebhook } from "./runtime";

const probeOversizedBody = (): Promise<
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
      BROWSER_ORIGIN: "https://app.fidyapp.com",
      KAPSO_API_KEY: "test-key",
      WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
      KAPSO_WEBHOOK_SECRET: "test-secret",
      WHATSAPP_BUSINESS_PORTFOLIO_ID: "test-portfolio",
      onHostedText: () => Promise.reject(new Error("Oversized bytes cannot admit a Turn")),
    })(request)
  );

  const deadline = new AbortController();

  const pending = Effect.runPromise(
    Effect.sleep(Duration.millis(100)).pipe(Effect.as("pending" as const)),
    {
      signal: deadline.signal,
    }
  );

  return Promise.race([response, pending]).then((observed) => {
    finishCancellation();
    deadline.abort();

    return response.then(() => ({ observed, cancellationStarted, locked: body.locked }));
  });
};

it("releases an oversized webhook body without waiting for hostile cancellation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() => probeOversizedBody());
      expect(result.observed).not.toBe("pending");

      assert(result.observed !== "pending");
      expect(result.observed.status).toBe(413);
      expect(result.cancellationStarted).toBe(true);
      expect(result.locked).toBe(false);
    })
  ));
