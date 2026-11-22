import { readWhatsAppStatementMedia as readStatementMedia } from "~/shell/ingestion/internal/whatsapp-media";
import { type StatementSourceFormat, maximumStatementBytes } from "~/core/ingestion/contract";
import { Effect, Option, Predicate, Schema } from "effect";

import type { CapturedInterpretationContext } from "~/core/interpretation-evidence/contract";
import { ReceivedEmailContent } from "~/shell/ingestion/internal/material";
import {
  NotificationEmailOutcome,
  type ParsedStatement,
  StatementParseFailed,
  StatementParseFailureReason,
} from "./contract";
import { interpretNotificationEmail as interpretDecodedEmail } from "~/shell/ingestion/internal/email-interpretation/interpret";

export const readWhatsAppStatementMedia: typeof readStatementMedia = (input) =>
  readStatementMedia(input);

const zipFirstByte = 0x50;

const zipSecondByte = 0x4b;

const unsupportedSignatures = ["JVBERg==", "iVBORw==", "/9j/", "R0lGOA==", "Qk0=", "UklGRg=="].map(
  (signature) => Uint8Array.fromBase64(signature)
);

const protectedOfficeSignature = Uint8Array.fromBase64("0M8R4KGxGuE=");

const startsWith = (bytes: Uint8Array, signature: Uint8Array): boolean =>
  signature.every((value, index) => bytes[index] === value);

export const knownUnsupportedStatementBytes = (bytes: Uint8Array): boolean =>
  unsupportedSignatures.some((signature) => startsWith(bytes, signature)) ||
  startsWith(bytes, protectedOfficeSignature);

export const statementSourceFormat = (bytes: Uint8Array): StatementSourceFormat =>
  bytes.slice(0, 2).join(",") === `${zipFirstByte},${zipSecondByte}` ? "xlsx" : "csv";

const statementParseFailure = (failure: unknown): StatementParseFailed =>
  Predicate.isTagged(failure, "StatementParseFailed") &&
  Predicate.hasProperty(failure, "safeReason") &&
  Schema.is(StatementParseFailureReason)(failure.safeReason)
    ? new StatementParseFailed({ safeReason: failure.safeReason })
    : new StatementParseFailed({ safeReason: "malformed-file" });

export const parseStatementFile = (
  bytes: Uint8Array
): Effect.Effect<ParsedStatement, StatementParseFailed> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        if (bytes.length === 0) throw new StatementParseFailed({ safeReason: "malformed-file" });

        if (bytes.length > maximumStatementBytes) {
          throw new StatementParseFailed({ safeReason: "resource-limit" });
        }

        if (knownUnsupportedStatementBytes(bytes)) {
          throw new StatementParseFailed({ safeReason: "unsupported-format" });
        }
      },
      catch: statementParseFailure,
    });

    const parser = yield* Effect.tryPromise(() => import("~/shell/ingestion/internal/parser")).pipe(
      Effect.orDie
    );

    return yield* Effect.try({
      try: () => {
        const parsed =
          statementSourceFormat(bytes) === "xlsx"
            ? parser.parseXlsx(bytes)
            : parser.parseCsv(bytes);

        return { sourceFormat: parsed.sourceFormat, headers: parsed.headers, rows: parsed.rows };
      },
      catch: statementParseFailure,
    });
  });

export const interpretNotificationEmail = (
  input: Readonly<{
    content: unknown;
    context: CapturedInterpretationContext;
  }>
): Effect.Effect<NotificationEmailOutcome> =>
  Effect.gen(function* () {
    const content = Schema.decodeUnknownOption(ReceivedEmailContent)(input.content);

    if (Option.isNone(content)) {
      return NotificationEmailOutcome.NeedsReview({ reason: "canonical-validation-failed" });
    }

    return yield* interpretDecodedEmail({ content: content.value, context: input.context });
  });
