import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { CapturedInterpretationContext } from "~/core/_shared/captured-interpretation-context";
import { encodeMoneyAmount } from "~/core/_shared/money";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { interpretNotificationEmail } from "./interpret";

const context = Schema.decodeSync(CapturedInterpretationContext)({
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
});

const fixtureUrl = (name: string): URL =>
  new URL(`./formats/${name}/fixtures/positive.synthetic.html`, import.meta.url);

const interpretFixture = Effect.fn(function* (name: string) {
  const html = yield* Effect.tryPromise(() => Bun.file(fixtureUrl(name)).text()).pipe(Effect.orDie);
  return yield* interpretNotificationEmail({
    content: {
      receivedEmailId: ResendReceivedEmailId.make(`received-${name}`),
      from: "untrusted@example.test",
      to: ["private@ingest.fidyapp.com"],
      subject: "Untrusted subject",
      text: Option.none(),
      html: Option.some(html),
      inlineImages: [],
      messageId: Option.none(),
      createdAt: DateTime.makeUnsafe("2026-01-18T12:00:00Z"),
    },
    context,
  });
});

it.effect(
  "interprets each evidenced format through one interface with local immutable evidence",
  () =>
    Effect.gen(function* () {
      const davibank = yield* interpretFixture("davibank-card");
      expect(davibank._tag).toBe("Interpreted");
      if (davibank._tag === "Interpreted") {
        expect(davibank.evidence).toMatchObject({
          formatId: "davibank-card",
          revision: "davibank-card-v1",
          currencyBasis: "format-cop-default-v1",
        });
        expect(encodeMoneyAmount(davibank.extraction.money.amount)).toBe("12500");
        expect(davibank.extraction.money.currency).toBe("COP");
        expect(davibank.extraction.direction).toBe("outflow");
        expect(davibank.extraction.counterparty).toEqual(Option.none());
        expect(davibank.evidence.accountHints.instrumentLabel).toEqual(Option.some("visa oro"));
        expect(DateTime.formatIso(davibank.extraction.occurredAt)).toBe("2026-01-15T15:15:30.000Z");
      }

      const bbva = yield* interpretFixture("bbva-pse");
      expect(bbva._tag).toBe("Interpreted");
      if (bbva._tag === "Interpreted") {
        expect(bbva.evidence.formatId).toBe("bbva-pse");
        expect(bbva.evidence.accountHints.accountLastFour).toEqual(Option.some("0012"));
        expect(bbva.evidence.accountHints.cardLastFour).toEqual(Option.none());
        expect(encodeMoneyAmount(bbva.extraction.money.amount)).toBe("125000");
      }

      const rappicard = yield* interpretFixture("rappicard-purchase");
      expect(rappicard._tag).toBe("Interpreted");
      if (rappicard._tag === "Interpreted") {
        expect(rappicard.evidence.formatId).toBe("rappicard-purchase");
        expect(rappicard.evidence.accountHints.cardLastFour).toEqual(Option.some("0034"));
        expect(rappicard.evidence.accountHints.instrumentLabel).toEqual(Option.some("rappicard"));
        expect(encodeMoneyAmount(rappicard.extraction.money.amount)).toBe("42500");
      }
    })
);

it.effect("uses explicit Currency and rejects conflicting Currency or unsafe suffix fields", () =>
  Effect.gen(function* () {
    const html = yield* Effect.tryPromise(() =>
      Bun.file(fixtureUrl("rappicard-purchase")).text()
    ).pipe(Effect.orDie);
    const interpret = (
      source: string,
      subject: Option.Option<string> = Option.none(),
      text: Option.Option<string> = Option.none()
    ): ReturnType<typeof interpretNotificationEmail> =>
      interpretNotificationEmail({
        content: {
          receivedEmailId: ResendReceivedEmailId.make("received-currency"),
          from: "untrusted@example.test",
          to: ["private@ingest.fidyapp.com"],
          subject: Option.getOrElse(subject, () => "Untrusted subject"),
          text,
          html: Option.some(source),
          inlineImages: [],
          messageId: Option.none(),
          createdAt: DateTime.makeUnsafe("2026-01-18T12:00:00Z"),
        },
        context,
      });
    const explicit = yield* interpret(html.replace("$42.500", "USD 42.500"));
    expect(explicit._tag).toBe("Interpreted");
    if (explicit._tag === "Interpreted") {
      expect(explicit.extraction.money.currency).toBe("USD");
      expect(explicit.evidence.currencyBasis).toBe("explicit");
    }
    expect((yield* interpret(html.replace("$42.500", "COP USD 42.500")))._tag).toBe("NeedsReview");
    const withCurrencyRow = (value: string): string =>
      html.replace("</table>", `<tr><td>Currency</td><td>${value}</td></tr></table>`);
    const rowExplicit = yield* interpret(withCurrencyRow("USD"));
    expect(rowExplicit._tag).toBe("Interpreted");
    if (rowExplicit._tag === "Interpreted") {
      expect(rowExplicit.extraction.money.currency).toBe("USD");
      expect(rowExplicit.evidence.currencyBasis).toBe("explicit");
    }
    expect((yield* interpret(withCurrencyRow("COP USD")))._tag).toBe("NeedsReview");
    expect((yield* interpret(withCurrencyRow("USD €")))._tag).toBe("NeedsReview");
    expect((yield* interpret(withCurrencyRow("US$")))._tag).toBe("NeedsReview");
    expect((yield* interpret(withCurrencyRow("dólares")))._tag).toBe("NeedsReview");
    expect(
      (yield* interpret(
        withCurrencyRow("USD").replace("</table>", "<tr><td>Moneda</td><td>USD</td></tr></table>")
      ))._tag
    ).toBe("NeedsReview");
    expect(
      (yield* interpret(
        html.replace("</table>", "<tr><td>Monto</td><td>$42.500</td></tr></table>")
      ))._tag
    ).toBe("NeedsReview");
    expect((yield* interpret(html.replace("654321", "pago pse")))._tag).toBe("NeedsReview");

    const completeNumber = "4111111111111111";
    for (const unsafe of [
      interpret(html.replace("*0034", completeNumber)),
      interpret(html.replace("TIENDA FICTICIA", completeNumber)),
      interpret(html.replace("654321", completeNumber)),
      interpret(html, Option.some(completeNumber)),
      interpret(html, Option.none(), Option.some(completeNumber)),
      interpret(html.replace("<body>", `<body data-reference="${completeNumber}">`)),
      interpret(html.replace("TIENDA FICTICIA", "1234567890")),
      interpret(html.replace("TIENDA FICTICIA", "1234 5678 9012")),
      interpret(html.replace("TIENDA FICTICIA", "1234.5678.9012")),
      interpret(html.replace("TIENDA FICTICIA", "411111-111111-1111")),
      interpret(html.replace("TIENDA FICTICIA", "12345678901234567890")),
      interpret(html.replace("TIENDA FICTICIA", "４１１１１１１１１１１１１１１１")),
    ]) {
      expect(yield* unsafe).toEqual({ _tag: "NeedsReview", reason: "invalid-format" });
    }
  })
);

it.effect("fails closed for unknown, image-only, ambiguous, and complete-number material", () =>
  Effect.gen(function* () {
    const make = (
      html: string,
      inlineImages: ReadonlyArray<never> = []
    ): ReturnType<typeof interpretNotificationEmail> =>
      interpretNotificationEmail({
        content: {
          receivedEmailId: ResendReceivedEmailId.make("received-unsafe"),
          from: "untrusted@example.test",
          to: ["private@ingest.fidyapp.com"],
          subject: "Untrusted subject",
          text: Option.none(),
          html: Option.some(html),
          inlineImages,
          messageId: Option.none(),
          createdAt: DateTime.makeUnsafe("2026-01-18T12:00:00Z"),
        },
        context,
      });
    expect((yield* make("<p>Compra desconocida</p>"))._tag).toBe("NeedsReview");
    const davibank = yield* Effect.tryPromise(() =>
      Bun.file(fixtureUrl("davibank-card")).text()
    ).pipe(Effect.orDie);
    const rappicard = yield* Effect.tryPromise(() =>
      Bun.file(fixtureUrl("rappicard-purchase")).text()
    ).pipe(Effect.orDie);
    expect(yield* make(`${davibank}${rappicard}`)).toMatchObject({
      _tag: "NeedsReview",
      reason: "ambiguous-format",
    });
    expect((yield* make("<p>rappicard pago pse davibank 4111111111111111</p>"))._tag).toBe(
      "NeedsReview"
    );
    const imageOnly = yield* interpretNotificationEmail({
      content: {
        receivedEmailId: ResendReceivedEmailId.make("received-image"),
        from: "untrusted@example.test",
        to: ["private@ingest.fidyapp.com"],
        subject: "Untrusted subject",
        text: Option.none(),
        html: Option.none(),
        inlineImages: [{ contentId: "one", mediaType: "image/png", content: new Uint8Array([1]) }],
        messageId: Option.none(),
        createdAt: DateTime.makeUnsafe("2026-01-18T12:00:00Z"),
      },
      context,
    });
    expect(imageOnly).toMatchObject({ _tag: "NeedsReview", reason: "unsupported-content" });

    const deeplyNested = `<table><tr><td>${"<div>".repeat(20_000)}x${"</div>".repeat(
      20_000
    )}</td><td>value</td></tr></table>`;
    expect(yield* make(deeplyNested)).toMatchObject({
      _tag: "NeedsReview",
      reason: "unsupported-content",
    });
    for (const hidden of [
      rappicard.replace("<body>", "<body hidden>"),
      rappicard.replace("<body>", '<body style="display: none">'),
      rappicard.replace("<body>", '<body aria-hidden="true">'),
      rappicard.replace("<body>", "<body><style>table { display: none }</style>"),
    ]) {
      expect(yield* make(hidden)).toMatchObject({
        _tag: "NeedsReview",
        reason: "unsupported-content",
      });
    }
  })
);
