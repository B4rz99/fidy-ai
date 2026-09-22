import assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Option } from "effect";
import { EmailAddress, EmailVerificationCode } from "~/core/email-authentication/model";
import { OutboundHttp } from "~/shell/outbound-http/operations";
import { EmailDeliveryPort, EmailSendFailed } from "./delivery";

const deliveryConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    NODE_ENV: "production",
    RESEND_FROM_EMAIL: "obarboza@fidyapp.com",
    RESEND_FROM_NAME: "Fidy",
  })
);

it.effect("maps Resend redirect responses to closed definitive failures", () =>
  Effect.gen(function* () {
    for (const status of [302, 307, 308]) {
      const layer = EmailDeliveryPort.layer.pipe(
        Layer.provide(
          Layer.succeed(OutboundHttp, {
            execute: () =>
              Effect.succeed({
                status,
                headers: {},
                body: new TextEncoder().encode("private redirect body"),
              }),
          })
        ),
        Layer.provide(deliveryConfig)
      );
      const context = yield* Layer.build(layer);
      const delivery = Context.get(context, EmailDeliveryPort);

      const exit = yield* delivery
        .send({
          purpose: "verified-onboarding",
          to: EmailAddress.make("person@example.com"),
          combinedCode: EmailVerificationCode.make("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ"),
          idempotencyKey: "private-delivery-idempotency",
        })
        .pipe(Effect.exit);
      const unannotatedExit = Exit.isFailure(exit)
        ? Exit.fail(Option.getOrThrow(Cause.findErrorOption(exit.cause)))
        : exit;

      assert.deepStrictEqual(
        unannotatedExit,
        Exit.fail(new EmailSendFailed({ certainty: "rejected", retryable: false }))
      );
      expect(String(exit)).not.toContain("private redirect body");
    }
  })
);
