import { DateTime, Function, Option, Schema } from "effect";
import type { Prompt } from "effect/unstable/ai";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { categoryRows } from "~/core/categories/taxonomy";
import type { User } from "~/core/identity/model";
import { AgentBearerToken } from "~/core/tokens/model";
import { TranscriptText } from "~/core/transcript/model";
import type { TranscriptWindowEntry } from "~/core/transcript/rules";
import { encodeOpenAiToolName } from "./toolkit";

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

/** Replaces only oversized tool outcomes in model context, leaving retained Transcript entries unchanged. */
export const projectTranscriptForModel: {
  (
    maxToolResultCharacters: number
  ): (entries: ReadonlyArray<TranscriptWindowEntry>) => ReadonlyArray<TranscriptWindowEntry>;
  (
    entries: ReadonlyArray<TranscriptWindowEntry>,
    maxToolResultCharacters: number
  ): ReadonlyArray<TranscriptWindowEntry>;
} = Function.dual(
  2,
  (entries: ReadonlyArray<TranscriptWindowEntry>, maxToolResultCharacters: number) =>
    entries.map((entry) => {
      if (
        entry._tag !== "CanonicalToolResultEntry" ||
        JSON.stringify(entry.outcome).length <= maxToolResultCharacters
      ) {
        return entry;
      }
      return {
        ...entry,
        outcome: { _tag: "ToolOutputRejected", failure: oversizedToolResult },
      };
    })
);

const bearerStart = "fin_";
const bearerCharacter = /^[A-Za-z0-9_-]$/;
const identifierPattern =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;

const containsAgentBearerToken = (text: string): boolean => {
  for (
    let start = text.indexOf(bearerStart);
    start >= 0;
    start = text.indexOf(bearerStart, start + 1)
  ) {
    let end = start + bearerStart.length;
    while (end < text.length && bearerCharacter.test(text[end] ?? "")) end += 1;
    if (Schema.is(AgentBearerToken)(text.slice(start, end))) return true;
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

const hasValidPaymentCardNumber = (text: string): boolean => {
  const candidates = text.replaceAll(identifierPattern, "").match(/(?:\d[\s./-]*){13,}/gu) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replaceAll(/\D/gu, "");
    if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) return false;
    let sum = 0;
    let doubleDigit = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      const digit = Number(digits[index]);
      const product = doubleDigit ? digit * 2 : digit;
      sum += product > 9 ? product - 9 : product;
      doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
  });
};

/** Detects bearer, provider-secret, payment-card, and account-number material in chat text. */
export const containsSensitiveChatValue = (text: string): boolean =>
  containsAgentBearerToken(text) ||
  providerSecretPattern.test(text) ||
  credentialUriPattern.test(text) ||
  labelledCredentialPattern.test(text) ||
  secretAssignmentPattern.test(text) ||
  hasAccountNumber(text) ||
  hasValidPaymentCardNumber(text);

/** Detects sensitive chat material anywhere in a JSON value before provider egress. */
export const containsSensitiveJson = (value: Schema.Json): boolean =>
  Option.fromNullishOr(JSON.stringify(value)).pipe(Option.exists(containsSensitiveChatValue));

/** Projects only explicit User context and current-turn time into the hosted model instructions. */
export const systemPrompt = ({
  user: { serviceMarket, locale, timeZone },
  occurredAt,
}: {
  readonly user: Pick<User, "serviceMarket" | "locale" | "timeZone">;
  readonly occurredAt: DateTime.Utc;
}) =>
  `Eres Fidy, un asistente de finanzas personales. ` +
  `El contexto explícito del Usuario es ServiceMarket ${serviceMarket}, locale ${locale} ` +
  `y zona IANA ${timeZone}. El turno comenzó en ${DateTime.formatIso(occurredAt)}. ` +
  `No infieras ese contexto de teléfonos, monedas ni proveedores. ` +
  `Las categorías canónicas disponibles son ${categoryRows
    .map(({ id, label }) => `${label}: ${id}`)
    .join(", ")}. ` +
  `Para modificar datos o leer datos privados no expresamente pedidos, pide al Usuario responder ` +
  `exactamente CONFIRMAR seguido del id canónico de la operación.`;

/** Converts a bounded Transcript window to provider messages while replacing sensitive values. */
export const transcriptPrompt = (
  entries: ReadonlyArray<TranscriptWindowEntry>
): ReadonlyArray<Prompt.MessageEncoded> => {
  const messages: Array<Prompt.MessageEncoded> = [];
  for (const entry of entries) {
    switch (entry._tag) {
      case "UserTranscriptEntry":
      case "AssistantTranscriptEntry":
        messages.push({
          role: entry._tag === "UserTranscriptEntry" ? "user" : "assistant",
          content: containsSensitiveChatValue(entry.text) ? credentialRejectedReply : entry.text,
        });
        break;
      case "CanonicalToolCallEntry":
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool-call",
              id: entry.toolCallId,
              name: encodeOpenAiToolName(CanonicalOperationId.make(entry.operation)),
              params: containsSensitiveJson(entry.input) ? sensitiveEntryRejected : entry.input,
            },
          ],
        });
        break;
      case "CanonicalToolResultEntry": {
        const failed = entry.outcome._tag !== "Succeeded";
        const canonicalResult =
          entry.outcome._tag === "Succeeded" ? entry.outcome.output : entry.outcome.failure;
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: entry.toolCallId,
              name: encodeOpenAiToolName(CanonicalOperationId.make(entry.operation)),
              result: containsSensitiveJson(canonicalResult)
                ? sensitiveEntryRejected
                : canonicalResult,
              isFailure: failed,
            },
          ],
        });
        break;
      }
    }
  }
  return messages;
};
