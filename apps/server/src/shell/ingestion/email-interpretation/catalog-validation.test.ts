import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { CapturedInterpretationContext } from "~/core/_shared/captured-interpretation-context";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import { Currency } from "~/core/_shared/money";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { AccountHints, NotificationFormatId } from "~/core/transactions/account-hints";
import type { NotificationEmailFormat } from "./format-definition";
import type { interpretNotificationEmail as InterpretNotificationEmail } from "./interpret";

const inertFormat = (
  id: string,
  revision: string,
  anchor = "specific-anchor"
): NotificationEmailFormat => ({
  id: NotificationFormatId.make(id),
  revision: InterpretationRevision.make(revision),
  routingAnchors: [anchor],
  interpret: () => Option.none(),
});

const importWithCatalog: (
  formats: ReadonlyArray<NotificationEmailFormat>
) => Promise<{ readonly interpretNotificationEmail: typeof InterpretNotificationEmail }> = (
  formats
) => {
  vi.resetModules();
  vi.doMock("./catalog.generated", () => ({ generatedFormats: formats }));
  return import("./interpret");
};

it.effect("rejects invalid and duplicate generated format identities and weak anchors", () =>
  Effect.gen(function* () {
    for (const formats of [
      [inertFormat("same", "one-v1"), inertFormat("same", "two-v1")],
      [inertFormat("one", "same-v1"), inertFormat("two", "same-v1")],
      [inertFormat("valid", "valid-v1", "x")],
    ]) {
      const error = yield* Effect.tryPromise(() => importWithCatalog(formats)).pipe(Effect.flip);
      expect(error).toBeDefined();
      vi.doUnmock("./catalog.generated");
    }
  })
);

it.effect("rejects canonical facts that fail final schema validation", () =>
  Effect.gen(function* () {
    const accountHints = yield* Schema.decodeEffect(AccountHints)({});
    const base = inertFormat("invalid-facts", "invalid-facts-v1", "invalid-facts-anchor");
    const format: NotificationEmailFormat = {
      ...base,
      interpret: () =>
        Option.some({
          amount: "not-an-amount",
          currency: Currency.make("COP"),
          currencyBasis: "format-cop-default-v1",
          occurredAt: DateTime.makeUnsafe("2026-01-18T12:00:00Z"),
          accountHints,
        }),
    };
    const { interpretNotificationEmail } = yield* Effect.promise(() => importWithCatalog([format]));
    const context = yield* Schema.decodeEffect(CapturedInterpretationContext)({
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: "America/Bogota",
    });
    const result = yield* interpretNotificationEmail({
      content: {
        receivedEmailId: ResendReceivedEmailId.make("received-invalid-facts"),
        from: "untrusted@example.test",
        to: ["private@ingest.fidyapp.com"],
        subject: "subject",
        text: Option.none(),
        html: Option.some("<p>invalid-facts-anchor</p>"),
        inlineImages: [],
        messageId: Option.none(),
        createdAt: DateTime.makeUnsafe("2026-01-18T12:00:00Z"),
      },
      context,
    });
    expect(result).toEqual({ _tag: "NeedsReview", reason: "invalid-format" });
    vi.doUnmock("./catalog.generated");
  })
);

it.effect("bounds competing candidates from a valid generated catalog", () =>
  Effect.gen(function* () {
    const formats = Array.from({ length: 9 }, (_, index) =>
      inertFormat(
        NotificationFormatId.make(`format-${index}`),
        InterpretationRevision.make(`format-${index}-v1`),
        "shared-anchor"
      )
    );
    const { interpretNotificationEmail } = yield* Effect.promise(() => importWithCatalog(formats));
    const context = yield* Schema.decodeEffect(CapturedInterpretationContext)({
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: "America/Bogota",
    });
    const result = yield* interpretNotificationEmail({
      content: {
        receivedEmailId: ResendReceivedEmailId.make("received-catalog-test"),
        from: "untrusted@example.test",
        to: ["private@ingest.fidyapp.com"],
        subject: "subject",
        text: Option.none(),
        html: Option.some("<p>shared-anchor</p>"),
        inlineImages: [],
        messageId: Option.none(),
        createdAt: DateTime.makeUnsafe("2026-01-18T12:00:00Z"),
      },
      context,
    });
    expect(result).toEqual({ _tag: "NeedsReview", reason: "ambiguous-format" });
    vi.doUnmock("./catalog.generated");
  })
);
