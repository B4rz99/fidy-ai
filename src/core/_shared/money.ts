import { BigDecimal, Data, Effect, Order, Schema, SchemaTransformation } from "effect";

const currencyCodes = [
  "AED",
  "AFN",
  "ALL",
  "AMD",
  "AOA",
  "ARS",
  "AUD",
  "AWG",
  "AZN",
  "BAM",
  "BBD",
  "BDT",
  "BHD",
  "BIF",
  "BMD",
  "BND",
  "BOB",
  "BRL",
  "BSD",
  "BTN",
  "BWP",
  "BYN",
  "BZD",
  "CAD",
  "CDF",
  "CHF",
  "CLP",
  "CNY",
  "COP",
  "CRC",
  "CUP",
  "CVE",
  "CZK",
  "DJF",
  "DKK",
  "DOP",
  "DZD",
  "EGP",
  "ERN",
  "ETB",
  "EUR",
  "FJD",
  "FKP",
  "GBP",
  "GEL",
  "GHS",
  "GIP",
  "GMD",
  "GNF",
  "GTQ",
  "GYD",
  "HKD",
  "HNL",
  "HTG",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "IQD",
  "IRR",
  "ISK",
  "JMD",
  "JOD",
  "JPY",
  "KES",
  "KGS",
  "KHR",
  "KMF",
  "KPW",
  "KRW",
  "KWD",
  "KYD",
  "KZT",
  "LAK",
  "LBP",
  "LKR",
  "LRD",
  "LSL",
  "LYD",
  "MAD",
  "MDL",
  "MGA",
  "MKD",
  "MMK",
  "MNT",
  "MOP",
  "MRU",
  "MUR",
  "MVR",
  "MWK",
  "MXN",
  "MYR",
  "MZN",
  "NAD",
  "NGN",
  "NIO",
  "NOK",
  "NPR",
  "NZD",
  "OMR",
  "PAB",
  "PEN",
  "PGK",
  "PHP",
  "PKR",
  "PLN",
  "PYG",
  "QAR",
  "RON",
  "RSD",
  "RUB",
  "RWF",
  "SAR",
  "SBD",
  "SCR",
  "SDG",
  "SEK",
  "SGD",
  "SHP",
  "SLE",
  "SOS",
  "SRD",
  "SSP",
  "STN",
  "SVC",
  "SYP",
  "SZL",
  "THB",
  "TJS",
  "TMT",
  "TND",
  "TOP",
  "TRY",
  "TTD",
  "TWD",
  "TZS",
  "UAH",
  "UGX",
  "USD",
  "UYU",
  "UYW",
  "UZS",
  "VED",
  "VES",
  "VND",
  "VUV",
  "WST",
  "XAF",
  "XCD",
  "XCG",
  "XOF",
  "XPF",
  "YER",
  "ZAR",
  "ZMW",
  "ZWG",
] as const;

const zeroFractionCurrencies = new Set<(typeof currencyCodes)[number]>([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const threeFractionCurrencies = new Set<(typeof currencyCodes)[number]>([
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
]);

/**
 * A recognized monetary ISO 4217 denomination. This is the retained launch
 * snapshot of active currencies with defined fractional precision: ISO fund,
 * metal, accounting, testing, and no-currency codes are deliberately absent.
 * Currency is independent of ServiceMarket; accepting USD does not enable a
 * United States market or promise conversion to or from COP.
 */
export const Currency = Schema.Literals(currencyCodes).annotate({
  identifier: "Currency",
  description:
    "A recognized monetary ISO 4217 alphabetic code. It determines the maximum fractional precision of Money and does not imply that fidy operates in that currency's markets.",
});
export type Currency = typeof Currency.Type;

/** The ISO facts retained for one Currency accepted by this build. */
export interface CurrencyMetadata {
  readonly alphabeticCode: Currency;
  /** Maximum decimal places ISO 4217 assigns to ordinary values in this Currency. */
  readonly fractionalDigits: 0 | 2 | 3 | 4;
}

const fractionalDigits = (currency: Currency): CurrencyMetadata["fractionalDigits"] => {
  if (zeroFractionCurrencies.has(currency)) {
    return 0;
  }
  if (threeFractionCurrencies.has(currency)) {
    return 3;
  }
  return currency === "UYW" ? 4 : 2;
};

/**
 * Reads the retained ISO metadata for an accepted Currency. Every member of
 * `Currency` has an answer from the static snapshot above; changing an ISO list
 * later must not erase metadata needed by existing Money.
 */
export const currencyMetadata = (alphabeticCode: Currency): CurrencyMetadata => ({
  alphabeticCode,
  fractionalDigits: fractionalDigits(alphabeticCode),
});

const plainDecimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const zero = BigDecimal.make(0n, 0);

type ReadonlyBigDecimal = Readonly<BigDecimal.BigDecimal>;
type ReadonlyMoney = {
  readonly amount: ReadonlyBigDecimal;
  readonly currency: Currency;
};

const formatPlainDecimal = (amount: ReadonlyBigDecimal): string => {
  const normalized = BigDecimal.normalize(amount);
  const digits = normalized.value.toString();

  if (normalized.scale <= 0) {
    return digits + "0".repeat(-normalized.scale);
  }
  if (normalized.scale >= digits.length) {
    return `0.${"0".repeat(normalized.scale - digits.length)}${digits}`;
  }

  const decimalAt = digits.length - normalized.scale;
  return `${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
};

/** Encodes an accepted decimal amount as normalized, non-exponent plain text. */
export const encodeMoneyAmount = formatPlainDecimal;

const MoneyAmount = Schema.String.check(
  Schema.isPattern(plainDecimalPattern, {
    expected: "non-negative plain decimal text without a sign, exponent, or locale formatting",
  })
).pipe(
  Schema.decodeTo(
    Schema.BigDecimal.check(Schema.isGreaterThanOrEqualToBigDecimal(zero)),
    SchemaTransformation.transform({
      decode: BigDecimal.fromStringUnsafe,
      encode: formatPlainDecimal,
    })
  )
);

const MoneyShape = Schema.Struct({
  amount: MoneyAmount.pipe(
    Schema.annotateEncoded({
      description:
        "A non-negative exact amount as plain decimal text. Responses remove insignificant trailing zeros and never use exponent or locale notation.",
    })
  ),
  currency: Currency,
}).annotate({
  description:
    "A non-negative exact decimal amount together with its ISO 4217 Currency. Currency precision is enforced and no conversion is implied.",
});

/**
 * Non-negative exact decimal value in one Currency. Decimal text preserves the
 * value across JSON, Currency controls the allowed fractional precision, and
 * encoding is normalized plain notation. Zero is valid until an owning
 * operation requires movement; arithmetic and comparison require equal
 * Currency and never perform FX conversion.
 */
export const Money = MoneyShape.check(
  Schema.makeFilter<ReadonlyMoney>((money) => {
    const usedDigits = Math.max(0, BigDecimal.normalize(money.amount).scale);
    const allowedDigits = currencyMetadata(money.currency).fractionalDigits;
    return usedDigits <= allowedDigits
      ? undefined
      : {
          path: ["amount"],
          issue: `${money.currency} Money permits at most ${allowedDigits} fractional digits`,
        };
  })
).annotate({ identifier: "Money" });
export type Money = typeof Money.Type;

/** Equal-Currency arithmetic was requested with two different denominations. */
export class CurrencyMismatch extends Data.TaggedError("CurrencyMismatch")<{
  readonly left: Currency;
  readonly right: Currency;
}> {}

const requireSameCurrency = (
  left: ReadonlyMoney,
  right: ReadonlyMoney
): Effect.Effect<void, CurrencyMismatch> =>
  left.currency === right.currency
    ? Effect.void
    : Effect.fail(new CurrencyMismatch({ left: left.currency, right: right.currency }));

/** Adds two Money values exactly, failing instead of mixing denominations. */
export const addMoney = (operands: {
  readonly left: ReadonlyMoney;
  readonly right: ReadonlyMoney;
}): Effect.Effect<Money, CurrencyMismatch> =>
  requireSameCurrency(operands.left, operands.right).pipe(
    Effect.as(
      Money.make({
        amount: BigDecimal.sum(operands.left.amount, operands.right.amount),
        currency: operands.left.currency,
      })
    )
  );

/** Compares two Money values in the same Currency, failing when they differ. */
export const compareMoney = (operands: {
  readonly left: ReadonlyMoney;
  readonly right: ReadonlyMoney;
}): Effect.Effect<-1 | 0 | 1, CurrencyMismatch> =>
  requireSameCurrency(operands.left, operands.right).pipe(
    Effect.as(BigDecimal.Order(operands.left.amount, operands.right.amount))
  );

/** Separate exact inflow and outflow sums for one Currency. */
export interface MoneyGroup {
  readonly currency: Currency;
  readonly inflow: ReadonlyMoney;
  readonly outflow: ReadonlyMoney;
}

/**
 * Groups Money by Currency in alphabetic order, keeping direction-separated
 * sums and omitting a Currency when both sums are zero. No net or converted
 * total is manufactured.
 */
export const groupMoney = (movements: {
  readonly inflows: ReadonlyArray<ReadonlyMoney>;
  readonly outflows: ReadonlyArray<ReadonlyMoney>;
}): Effect.Effect<ReadonlyArray<MoneyGroup>> => {
  const groups = new Map<
    Currency,
    { readonly inflow: ReadonlyBigDecimal; readonly outflow: ReadonlyBigDecimal }
  >();

  for (const inflow of movements.inflows) {
    const current = groups.get(inflow.currency) ?? { inflow: zero, outflow: zero };
    groups.set(inflow.currency, {
      ...current,
      inflow: BigDecimal.sum(current.inflow, inflow.amount),
    });
  }
  for (const outflow of movements.outflows) {
    const current = groups.get(outflow.currency) ?? { inflow: zero, outflow: zero };
    groups.set(outflow.currency, {
      ...current,
      outflow: BigDecimal.sum(current.outflow, outflow.amount),
    });
  }

  type GroupEntry = readonly [
    Currency,
    { readonly inflow: ReadonlyBigDecimal; readonly outflow: ReadonlyBigDecimal },
  ];

  return Effect.succeed(
    [...groups.entries()]
      .filter(
        ([, totals]: GroupEntry) =>
          !BigDecimal.isZero(totals.inflow) || !BigDecimal.isZero(totals.outflow)
      )
      .sort(([left]: GroupEntry, [right]: GroupEntry) => Order.String(left, right))
      .map(([currency, totals]: GroupEntry) => ({
        currency,
        inflow: Money.make({ amount: totals.inflow, currency }),
        outflow: Money.make({ amount: totals.outflow, currency }),
      }))
  );
};
