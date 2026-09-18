import { Function, Option, Schema } from "effect";
import { TokenBearer } from "~/core/tokens/model";
import { TranscriptText } from "~/core/transcript/model";
import {
  type TranscriptSelectionEntry,
  type TranscriptWindowEntry,
  isTranscriptWindowEntry,
} from "~/core/transcript/rules";

const minimumPaymentCardDigits = 13;
const maximumPaymentCardDigits = 19;
const largestSingleDigit = 9;
const luhnChecksumModulus = 10;

/** Stable channel-neutral response used when sensitive chat input is rejected. */
export const credentialRejectedReply = TranscriptText.make(
  "No envíes credenciales ni tokens por chat. Este mensaje no fue guardado ni procesado."
);

/** Safe replacement persisted when canonical model-boundary data contains a sensitive value. */
export const sensitiveEntryRejected: Schema.Json = {
  code: "sensitive_entry_rejected",
  message: "A sensitive value was removed at the model boundary.",
};

const oversizedToolResult: Schema.Json = {
  code: "tool_result_too_large",
  message: "The canonical result exceeded the model-context safety limit.",
};

/** Excludes lifecycle markers and replaces oversized tool outcomes without changing retained Transcript entries. */
export const projectTranscriptForModel: {
  (
    maxToolResultCharacters: number
  ): (entries: ReadonlyArray<TranscriptSelectionEntry>) => ReadonlyArray<TranscriptWindowEntry>;
  (
    entries: ReadonlyArray<TranscriptSelectionEntry>,
    maxToolResultCharacters: number
  ): ReadonlyArray<TranscriptWindowEntry>;
} = Function.dual(
  2,
  (entries: ReadonlyArray<TranscriptSelectionEntry>, maxToolResultCharacters: number) =>
    entries.flatMap((entry): ReadonlyArray<TranscriptWindowEntry> => {
      if (!isTranscriptWindowEntry(entry)) return [];
      if (
        entry._tag !== "CanonicalToolResultEntry" ||
        JSON.stringify(entry.outcome).length <= maxToolResultCharacters
      ) {
        return [entry];
      }
      return [
        {
          ...entry,
          outcome: { _tag: "ToolOutputRejected", failure: oversizedToolResult },
        },
      ];
    })
);

const bearerStart = "fin_";
const bearerCharacter = /^[A-Za-z0-9_-]$/;
const identifierPattern =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;

const containsTokenBearer = (text: string): boolean => {
  for (
    let start = text.indexOf(bearerStart);
    start >= 0;
    start = text.indexOf(bearerStart, start + 1)
  ) {
    let end = start + bearerStart.length;
    while (end < text.length && bearerCharacter.test(text[end] ?? "")) end += 1;
    if (Schema.is(TokenBearer)(text.slice(start, end))) return true;
  }
  return false;
};

const providerSecretPattern =
  /(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b|\bgh[opusr]_[A-Za-z0-9]{20,}\b|\bsk_live_[A-Za-z0-9]{20,}\b)/u;
const credentialUriPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu;
const labelledCredentialPattern =
  /\b(?:contrase(?:ña|na)|password|clave\s+(?:bancaria|de\s+(?:mi\s+)?banco)|pin\s+bancario|c[oó]digo\s+de\s+recuperaci[oó]n|frase\s+de\s+recuperaci[oó]n|recovery\s+(?:code|phrase))(?:\s+(?:del?|de\s+la|para\s+el)\s+(?:pdf|extracto|banco))?\s*(?:es|:|=)\s*\S{4,}/iu;
const secretAssignmentPattern =
  /\b(?:aws_(?:access_key_id|secret_access_key)|api_key|access_token|client_secret|[a-z][a-z0-9_]*(?:_api_key|_secret|_token))\s*[:=]\s*[^\s,;]{8,}/iu;
const accountContextPattern =
  /\b(?:iban|cuenta(?:\s+(?:de\s+)?(?:ahorros?|corriente|n[oó]mina|bancaria))?|(?:bank\s+)?account|acct\.?)\b/iu;
const accountNumberCandidatePattern =
  /\b(?:[A-Z]{2}\d{2}(?:[ A-Z0-9-]?){8,30}|(?:\d[ .-]?){8,34})\b/iu;

const hasAccountNumber = (text: string): boolean =>
  accountContextPattern.test(text) && accountNumberCandidatePattern.test(text);

const paymentCardCandidatePattern = /(?<![0-9a-f])(?:\d[\s./-]*){13,}(?![0-9a-f])/giu;

const hasValidPaymentCardNumber = (text: string): boolean => {
  const candidates =
    text.replaceAll(identifierPattern, "").match(paymentCardCandidatePattern) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replaceAll(/\D/gu, "");
    if (
      digits.length < minimumPaymentCardDigits ||
      digits.length > maximumPaymentCardDigits ||
      /^(\d)\1+$/u.test(digits)
    ) {
      return false;
    }
    let sum = 0;
    let doubleDigit = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      const digit = Number(digits[index]);
      const product = doubleDigit ? digit * 2 : digit;
      sum += product > largestSingleDigit ? product - largestSingleDigit : product;
      doubleDigit = !doubleDigit;
    }
    return sum % luhnChecksumModulus === 0;
  });
};

/** Detects bearer, provider-secret, payment-card, and account-number material in chat text. */
export const containsSensitiveChatValue = (text: string): boolean =>
  containsTokenBearer(text) ||
  providerSecretPattern.test(text) ||
  credentialUriPattern.test(text) ||
  labelledCredentialPattern.test(text) ||
  secretAssignmentPattern.test(text) ||
  hasAccountNumber(text) ||
  hasValidPaymentCardNumber(text);

/** Detects sensitive chat material anywhere in a JSON value before provider egress. */
export const containsSensitiveJson = (value: Schema.Json): boolean =>
  Option.fromNullishOr(JSON.stringify(value)).pipe(Option.exists(containsSensitiveChatValue));
