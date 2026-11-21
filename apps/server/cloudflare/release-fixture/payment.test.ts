import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { native, nativeBillingPlatform } from "../user-store.test-fixture";
import { acceptancePaymentToken } from "./contract";
import { acceptanceProviderResponse } from "./runtime";

const source = Effect.gen(function* () {
  const runtime = yield* (yield* nativeBillingPlatform)();

  const { EMAIL_BUCKET } = yield* native(() =>
    runtime.getBindings<{ EMAIL_BUCKET: R2Bucket }>("core")
  );

  const revision = "a".repeat(40);

  const first = "fidy-acceptance-" + revision + "-smoke-1",
    second = "fidy-acceptance-" + revision + "-smoke-2";

  const env = {
    RELEASE_GIT_SHA: revision,
    NATIVE_STORAGE_ADMISSION: "closed",
    SMOKE_BUCKET: EMAIL_BUCKET,
  };

  const register = Effect.fn(function* (
    subject: string,
    token: string,
    type: "CARD" | "NEQUI" = "CARD"
  ) {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      type,
      token,
      customer_email: subject + "@example.test",
    });

    return yield* acceptanceProviderResponse(
      new Request("https://sandbox.wompi.co/v1/payment_sources", { method: "POST", body }),
      env
    );
  });

  const token = acceptancePaymentToken({ kind: "CARD", subject: first });
  expect((yield* register(second, token)).status).toBe(400);
  expect((yield* register(first, token, "NEQUI")).status).toBe(400);
  expect((yield* register("ordinary-user", token)).status).toBe(400);
  const approved = yield* register(first, token);
  expect(approved.status).toBe(200);
  expect(yield* native(() => approved.json())).toMatchObject({
    data: { type: "CARD", status: "AVAILABLE", customer_email: first + "@example.test" },
  });
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "accepts the release driver's card only for its synthetic enrollee and rejects foreign, unknown or mismatched instruments",
    () => source
  );
});
