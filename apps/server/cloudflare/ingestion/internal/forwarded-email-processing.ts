import { PrivateObjectKey } from "../../private-objects/contract";
import type { NotificationEmailOutcome } from "../../../src/shell/ingestion/contract";
import { type Data, DateTime, Effect, Option, Schema } from "effect";
import type PostalMime from "postal-mime";
import { ReceivedEmailId } from "../../../src/core/ingestion/contract";
import { CapturedInterpretationContext } from "../../../src/core/interpretation-evidence/contract";
import { interpretNotificationEmail } from "../../../src/shell/ingestion/operations";

const maximumTimeZoneCharacters = 128;

export const Receipt = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  object_key: PrivateObjectKey,
  delivery_digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  byte_length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_048_576 })),
  received_at_ms: Schema.Int,
  expires_at_ms: Schema.Int,
  time_zone: Schema.String.check(Schema.isBetweenLength(1, maximumTimeZoneCharacters)),
});

type Receipt = typeof Receipt.Type;

type EmailOutcome =
  | NotificationEmailOutcome
  | Data.TaggedEnum<{ NeedsReview: { readonly reason: "canonical-validation-failed" } }>;

const maximumTagCount = 9999;

const structuralTags = ["table", "tr", "td", "p", "span", "div"] as const;

export const anonymizeStructure = (html: string): string => {
  const counts: Record<(typeof structuralTags)[number], number> = {
    table: 0,
    tr: 0,
    td: 0,
    p: 0,
    span: 0,
    div: 0,
  };

  for (const match of html.matchAll(/<([a-z]+)(?=[\s/>])/giu)) {
    const tag = match[1]?.toLowerCase();

    for (const allowed of structuralTags) {
      if (tag === allowed) counts[allowed] = Math.min(maximumTagCount, counts[allowed] + 1);
    }
  }

  return JSON.stringify(counts);
};

export const decideEmail = ({
  parsed,
  receipt,
}: {
  parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  receipt: Receipt;
}): Effect.Effect<EmailOutcome, Schema.SchemaError> =>
  Effect.gen(function* () {
    const content = {
      receivedEmailId: ReceivedEmailId.make(receipt.id),
      from: parsed.from?.address ?? "",
      to: (parsed.to ?? []).map((recipient) => recipient.address ?? ""),
      subject: parsed.subject ?? "",
      ...Option.match(Option.fromUndefinedOr(parsed.text), {
        onNone: () => ({}),
        onSome: (text) => ({ text }),
      }),
      ...Option.match(Option.fromUndefinedOr(parsed.html), {
        onNone: () => ({}),
        onSome: (html) => ({ html }),
      }),
      inlineImages: [],
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(receipt.received_at_ms)),
    };

    return yield* interpretNotificationEmail({
      content,
      context: yield* Schema.decodeEffect(CapturedInterpretationContext)({
        serviceMarket: "CO",
        locale: "es-CO",
        timeZone: receipt.time_zone,
      }),
    });
  });
