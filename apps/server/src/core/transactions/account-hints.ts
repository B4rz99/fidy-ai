import { Effect, Option, Schema, SchemaTransformation } from "effect";

const maxHintTextCodePoints = 64;

/** An explicitly identified card or account suffix; leading zeros are significant. */
export const LastFourDigits = Schema.String.check(Schema.isPattern(/^[0-9]{4}$/u))
  .pipe(Schema.brand("LastFourDigits"))
  .annotate({ identifier: "LastFourDigits" });
export type LastFourDigits = typeof LastFourDigits.Type;

/** Stable, source-format identity retained with deterministic notification interpretation. */
export const NotificationFormatId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  Schema.isMaxLength(maxHintTextCodePoints)
)
  .pipe(Schema.brand("NotificationFormatId"))
  .annotate({ identifier: "NotificationFormatId" });
export type NotificationFormatId = typeof NotificationFormatId.Type;

/** Whether Currency was explicit or supplied by one sealed format-revision rule. */
export const NotificationCurrencyBasis = Schema.Literals(["explicit", "format-cop-default-v1"]);
export type NotificationCurrencyBasis = typeof NotificationCurrencyBasis.Type;

const normalizeInstrumentLabel = (text: string): string =>
  text
    .normalize("NFKC")
    .replaceAll(/\p{White_Space}+/gu, " ")
    .trim()
    .toLowerCase();

/**
 * A normalized explicit product label, not an institution or inferred account identity.
 * Formatting validation does not prove arbitrary prose safe: capture must independently restrict
 * label evidence before retaining it. The limit counts Unicode code points, not UTF-16 units.
 */
export const InstrumentLabel = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.makeFilter(
        (text) =>
          text.length > 0 &&
          Array.from(text).length <= maxHintTextCodePoints &&
          !/[\p{Cc}\p{Cf}]/u.test(text)
      )
    ).pipe(Schema.brand("InstrumentLabel")),
    SchemaTransformation.transform({
      decode: normalizeInstrumentLabel,
      encode: (text) => text,
    })
  )
).annotate({ identifier: "InstrumentLabel" });
export type InstrumentLabel = typeof InstrumentLabel.Type;

/**
 * Safe, partial SourceAttestation evidence. Slots are independently absent; equal digits across
 * card and account namespaces are not comparable and no hint establishes a Transaction match.
 */
export const AccountHints = Schema.Struct({
  cardLastFour: Schema.OptionFromOptionalKey(LastFourDigits),
  accountLastFour: Schema.OptionFromOptionalKey(LastFourDigits),
  instrumentLabel: Schema.OptionFromOptionalKey(InstrumentLabel),
}).annotate({ identifier: "AccountHints" });
export type AccountHints = typeof AccountHints.Type;

/** Versioned safe evidence retained only for a deterministically interpreted notification email. */
export const NotificationInterpretationEvidence = Schema.Struct({
  formatId: NotificationFormatId,
  currencyBasis: NotificationCurrencyBasis,
  accountHints: AccountHints,
}).annotate({ identifier: "NotificationInterpretationEvidence" });
export type NotificationInterpretationEvidence = typeof NotificationInterpretationEvidence.Type;

/** Comparison is supporting evidence only, never authority to link or resolve an Account. */
export const HintComparison = Schema.Literals(["equal", "conflict", "unknown"]);
export type HintComparison = typeof HintComparison.Type;

const differs = (
  left: Option.Option<LastFourDigits>,
  right: Option.Option<LastFourDigits>
): boolean =>
  Option.match(Option.all([left, right]), {
    onNone: () => false,
    onSome: (values: readonly [LastFourDigits, LastFourDigits]) => values[0] !== values[1],
  });

const tupleEquals: <Value>(values: readonly [Value, Value]) => boolean = (values) =>
  values[0] === values[1];

const equals: <Value>(left: Option.Option<Value>, right: Option.Option<Value>) => boolean = (
  left,
  right
) =>
  Option.match(Option.all([left, right]), {
    onNone: () => false,
    onSome: tupleEquals,
  });

/**
 * Compares already-decoded SourceAttestation hints without exposing their values to callers of
 * Reconciliation. Any differing same-kind suffix overrides agreement; different labels alone do
 * not conflict. Missing and cross-kind evidence never establishes equality.
 */
export const compareAccountHints = Effect.fn("compareAccountHints")(function (
  left: Readonly<AccountHints>,
  right: Readonly<AccountHints>
): Effect.Effect<HintComparison> {
  if (
    differs(left.cardLastFour, right.cardLastFour) ||
    differs(left.accountLastFour, right.accountLastFour)
  ) {
    return Effect.succeed("conflict");
  }
  const comparison =
    equals(left.cardLastFour, right.cardLastFour) ||
    equals(left.accountLastFour, right.accountLastFour) ||
    equals(left.instrumentLabel, right.instrumentLabel)
      ? "equal"
      : "unknown";
  return Effect.succeed(comparison);
});
