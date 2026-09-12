import { expect, layer } from "@effect/vitest";
import { BunCrypto } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { ForwardedEmailWorkflowPayload, forwardedEmailQueueId } from "./forwarded-email-execution";

// OpenSSL dgst -sha256 of "<userId>:<receivedEmailId>", truncated to 36 hexadecimal characters.
layer(BunCrypto.layer)("ForwardedEmail durable identity", (it) => {
  it.effect("keeps the durable queue identity stable for a forwarded-email payload", () =>
    Effect.gen(function* () {
      const payload = yield* Schema.decodeEffect(ForwardedEmailWorkflowPayload)({
        userId: "f1d1a000-0000-4000-8000-000000000101",
        receivedEmailId: "received-queue-identity",
      });
      expect(yield* forwardedEmailQueueId(payload)).toBe("8181a7687a0664a868d4235a05fea66b18c3");
    })
  );
});
