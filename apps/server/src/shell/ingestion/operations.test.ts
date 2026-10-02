import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { CapturedInterpretationContext } from "~/core/interpretation-evidence/contract";
import { interpretNotificationEmail } from "./operations";

it.effect(
  "refuses invalid retained email before deterministic interpretation exposes an outcome",
  () =>
    Effect.gen(function* () {
      const context = yield* Schema.decodeEffect(CapturedInterpretationContext)({
        serviceMarket: "CO",
        locale: "es-CO",
        timeZone: "America/Bogota",
      });
      const result = yield* interpretNotificationEmail({
        context,
        content: {
          receivedEmailId: "received-invalid-content",
          from: "untrusted@example.test",
          to: ["private@ingest.fidyapp.com"],
          subject: "x".repeat(999),
          html: "<p>Unrecognized notification</p>",
          inlineImages: [],
          createdAt: "2026-01-18T12:00:00Z",
        },
      });
      expect(result).toEqual({ _tag: "NeedsReview", reason: "canonical-validation-failed" });
    })
);
