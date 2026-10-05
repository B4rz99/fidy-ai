import { readWhatsAppStatementMedia as readStatementMedia } from "~/shell/ingestion/internal/whatsapp-media";
import { type StatementSourceFormat, maximumStatementBytes } from "~/core/ingestion/contract";
import { Effect, Option, Schema } from "effect";

import type { CapturedInterpretationContext } from "~/core/interpretation-evidence/contract";
import { ReceivedEmailContent } from "~/shell/ingestion/internal/material";
import {
  type NotificationEmailOutcome,
  type ParsedStatement,
  StatementParseFailed,
} from "./contract";
import { parseCsv, parseXlsx } from "~/shell/ingestion/internal/parser";
import { interpretNotificationEmail as interpretDecodedEmail } from "~/shell/ingestion/internal/email-interpretation/interpret";

/** Retrieve only a bounded statement document through the closed provider media interface. */
export const readWhatsAppStatementMedia: typeof readStatementMedia = (input) =>
  readStatementMedia(input);

const zipFirstByte = 0x50;
const zipSecondByte = 0x4b;

/** Base64 signatures of common non-tabular uploads; content decides, never a claimed type. */
const unsupportedSignatures = ["JVBERg==", "iVBORw==", "/9j/", "R0lGOA==", "Qk0=", "UklGRg=="].map(
  (signature) => Uint8Array.fromBase64(signature)
);
// Encrypted Office documents use OLE Compound File, not the ZIP container of supported XLSX.
const protectedOfficeSignature = Uint8Array.fromBase64("0M8R4KGxGuE=");

const startsWith = (bytes: Uint8Array, signature: Uint8Array): boolean =>
  signature.every((value, index) => bytes[index] === value);

/**
 * True when the leading bytes identify an unsupported format — PDF, protected Office documents,
 * PNG, JPEG, GIF, BMP, or RIFF/WebP. Staging and parsing share this gate, so a mismatched claim cannot decide
 * whether hostile content is admitted.
 */
export const knownUnsupportedStatementBytes = (bytes: Uint8Array): boolean =>
  unsupportedSignatures.some((signature) => startsWith(bytes, signature)) ||
  startsWith(bytes, protectedOfficeSignature);

/** Sniffs the deterministic parser from uploaded bytes rather than untrusted MIME metadata. */
export const statementSourceFormat = (bytes: Uint8Array): StatementSourceFormat =>
  bytes.slice(0, 2).join(",") === `${zipFirstByte},${zipSecondByte}` ? "xlsx" : "csv";

/**
 * Decodes one bounded untrusted statement without executing active workbook content. Only rows
 * required by native finalization leave the owner; mapping samples and parser details stay private.
 */
export const parseStatementFile = (
  bytes: Uint8Array
): Effect.Effect<ParsedStatement, StatementParseFailed> =>
  Effect.try({
    try: () => {
      if (bytes.length === 0) throw new StatementParseFailed({ safeReason: "malformed-file" });
      if (bytes.length > maximumStatementBytes) {
        throw new StatementParseFailed({ safeReason: "resource-limit" });
      }
      if (knownUnsupportedStatementBytes(bytes)) {
        throw new StatementParseFailed({ safeReason: "unsupported-format" });
      }
      const parsed = statementSourceFormat(bytes) === "xlsx" ? parseXlsx(bytes) : parseCsv(bytes);
      return { sourceFormat: parsed.sourceFormat, headers: parsed.headers, rows: parsed.rows };
    },
    catch: (failure) =>
      failure instanceof StatementParseFailed
        ? failure
        : new StatementParseFailed({ safeReason: "malformed-file" }),
  });

/**
 * Validate one provider-decoded retained email and return its canonical extraction or closed review
 * reason. The input is encoded untrusted material, including an ISO timestamp and optional text/HTML;
 * no raw content, schema, format catalog, model request, or fetched reference escapes this operation.
 */
export const interpretNotificationEmail = (
  input: Readonly<{
    content: unknown;
    context: CapturedInterpretationContext;
  }>
): Effect.Effect<NotificationEmailOutcome> =>
  Effect.gen(function* () {
    const content = Schema.decodeUnknownOption(ReceivedEmailContent)(input.content);
    if (Option.isNone(content)) {
      return { _tag: "NeedsReview", reason: "canonical-validation-failed" };
    }
    return yield* interpretDecodedEmail({ content: content.value, context: input.context });
  });
