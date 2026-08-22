import { DateTime, Option, Schema, SchemaTransformation } from "effect";
/** Minimum cadence advertised to browsers polling a pairing challenge. */
export const browserLoginPollingIntervalSeconds = 5;

/** Unambiguous base-20 alphabet used by every public-code representation. */
export const browserLoginPublicCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ" as const;

const browserLoginPublicCodePattern = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u;
const browserLoginPublicCodeSymbolsPattern = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/u;

/** Public, human-entered code. Its possession never establishes a browser session. */
export const BrowserLoginPublicCode = Schema.String.check(
  Schema.isPattern(browserLoginPublicCodePattern)
)
  .pipe(Schema.brand("BrowserLoginPublicCode"))
  .annotate({ identifier: "BrowserLoginPublicCode" });
export type BrowserLoginPublicCode = typeof BrowserLoginPublicCode.Type;

/** Fixed lifetime applied by the server when it creates an unbound challenge. */
export const browserLoginPairingLifetime = "10 minutes" as const;

const unbiasedBase20ByteLimit = 240;

/** Selects at most `maximum` uniform code symbols, rejecting biased random-byte values. */
export const selectPublicCodeSymbols = (
  input: Readonly<{ readonly bytes: ReadonlyArray<number>; readonly maximum: number }>
): string => {
  let accepted = "";
  for (const byte of input.bytes) {
    if (byte >= unbiasedBase20ByteLimit) continue;
    accepted += browserLoginPublicCodeAlphabet[byte % browserLoginPublicCodeAlphabet.length];
    if (accepted.length === input.maximum) break;
  }
  return accepted;
};

/** Eight validated symbols sampled from the public-code alphabet before display formatting. */
export const BrowserLoginPublicCodeSymbols = Schema.String.check(
  Schema.isPattern(browserLoginPublicCodeSymbolsPattern)
).pipe(Schema.brand("BrowserLoginPublicCodeSymbols"));
export type BrowserLoginPublicCodeSymbols = typeof BrowserLoginPublicCodeSymbols.Type;

/** Formats eight validated base-20 symbols into the only canonical public spelling. */
export const formatPublicCode = (symbols: BrowserLoginPublicCodeSymbols): BrowserLoginPublicCode =>
  BrowserLoginPublicCode.make(`${symbols.slice(0, 4)}-${symbols.slice(4)}`);

/** Decides whether a pending challenge may replace the User's current Ready challenge. */
export const decideApprovalTransition = (input: {
  readonly candidateOrdinal: bigint;
  readonly readyOrdinal: Option.Option<bigint>;
}): "bind" | "reject" =>
  Option.match(input.readyOrdinal, {
    onNone: () => "bind",
    onSome: (readyOrdinal) => (readyOrdinal < input.candidateOrdinal ? "bind" : "reject"),
  });

/** Expiry is fixed by the challenge creation instant, not caller input. */
export const browserLoginPairingExpiry = (createdAt: DateTime.Utc): DateTime.Utc =>
  DateTime.addDuration(createdAt, browserLoginPairingLifetime);

const normalizePublicCodeText = (input: string): string => {
  const upper = input.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, "").toUpperCase();
  if (browserLoginPublicCodePattern.test(upper)) return upper;
  return browserLoginPublicCodeSymbolsPattern.test(upper)
    ? `${upper.slice(0, 4)}-${upper.slice(4)}`
    : upper;
};

/** Public decoder with narrow ASCII presentation normalization and canonical encoding. */
export const BrowserLoginPublicCodeInput = Schema.String.pipe(
  Schema.decodeTo(
    BrowserLoginPublicCode,
    SchemaTransformation.transform({
      decode: normalizePublicCodeText,
      encode: (code) => code,
    })
  )
);
