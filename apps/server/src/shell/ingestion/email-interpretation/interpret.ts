import { DateTime, Effect, Option, Schema } from "effect";
import type { CapturedInterpretationContext } from "~/core/_shared/captured-interpretation-context";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import {
  NotificationEmailInterpretationReviewReason,
  type ReceivedEmailContent,
} from "~/core/ingestion/model";
import { TransactionExtraction } from "~/core/transactions/model";
import {
  NotificationFormatId,
  NotificationInterpretationEvidence,
} from "~/core/transactions/account-hints";
import { generatedFormats } from "./catalog.generated";
import { type EmailDocument, normalizeDocumentText, parseEmailDocument } from "./document";
import type { NotificationEmailFormat } from "./format-definition";
import { containsCompleteFinancialNumber } from "./format-support";

/** Closed review outcomes; none contains hostile email or parser text. */
export const EmailInterpretationReviewReason = NotificationEmailInterpretationReviewReason;
export type EmailInterpretationReviewReason = NotificationEmailInterpretationReviewReason;

/** Immutable source-specific facts explaining one accepted deterministic interpretation. */
export const NotificationEmailInterpretationEvidence = Schema.Struct({
  ...NotificationInterpretationEvidence.fields,
  revision: InterpretationRevision,
});
export type NotificationEmailInterpretationEvidence =
  typeof NotificationEmailInterpretationEvidence.Type;

/** One accepted canonical extraction or a fail-closed review decision. */
export type NotificationEmailInterpretation =
  | Readonly<{
      _tag: "Interpreted";
      extraction: TransactionExtraction;
      evidence: NotificationEmailInterpretationEvidence;
    }>
  | Readonly<{
      _tag: "NeedsReview";
      reason: EmailInterpretationReviewReason;
    }>;

const maximumCandidates = 8;
const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

type ValidatedCatalog = Readonly<{
  anchorFormats: ReadonlyMap<string, ReadonlyArray<NotificationEmailFormat>>;
  matcher: RegExp;
}>;

const validateIdentity = (
  format: NotificationEmailFormat,
  ids: Set<string>,
  revisions: Set<string>
): void => {
  if (!Schema.is(NotificationFormatId)(format.id) || ids.has(format.id)) {
    throw new Error("Invalid generated notification format id");
  }
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9]\d*$/u.test(format.revision) ||
    revisions.has(format.revision)
  ) {
    throw new Error("Invalid generated notification format revision");
  }
  ids.add(format.id);
  revisions.add(format.revision);
};

const validatedCatalog = ((): ValidatedCatalog => {
  const ids = new Set<string>();
  const revisions = new Set<string>();
  const anchorFormats = new Map<string, Array<NotificationEmailFormat>>();
  for (const format of generatedFormats) {
    validateIdentity(format, ids, revisions);
    for (const rawAnchor of format.routingAnchors) {
      const anchor = normalizeDocumentText(rawAnchor);
      if (anchor.length < 4) {
        throw new Error("Notification format routing anchors must be specific");
      }
      const formats = anchorFormats.get(anchor) ?? [];
      formats.push(format);
      anchorFormats.set(anchor, formats);
    }
  }
  const anchors = [...anchorFormats.keys()].sort((left, right) => right.length - left.length);
  return {
    anchorFormats,
    matcher: new RegExp(anchors.map(escapeRegExp).join("|"), "gu"),
  };
})();

const candidatesFor = (text: string): ReadonlyArray<NotificationEmailFormat> => {
  const candidates = new Set<NotificationEmailFormat>();
  for (const match of text.matchAll(validatedCatalog.matcher)) {
    const anchor = match[0];
    for (const format of validatedCatalog.anchorFormats.get(anchor) ?? []) candidates.add(format);
    if (candidates.size > maximumCandidates) break;
  }
  return [...candidates];
};

type InterpretationInput = Readonly<{
  content: ReceivedEmailContent;
  context: CapturedInterpretationContext;
}>;

const needsReview = (reason: EmailInterpretationReviewReason): NotificationEmailInterpretation => ({
  _tag: "NeedsReview",
  reason,
});

const selectCandidate = (
  document: EmailDocument
): NotificationEmailFormat | EmailInterpretationReviewReason => {
  const candidates = candidatesFor(document.text);
  if (candidates.length === 0) {
    return "unknown-format";
  }
  if (candidates.length !== 1) {
    return "ambiguous-format";
  }
  return Option.getOrElse(Option.fromNullishOr(candidates[0]), () => "unknown-format");
};

const finalizeInterpretation = (
  format: NotificationEmailFormat,
  document: EmailDocument,
  context: CapturedInterpretationContext
): NotificationEmailInterpretation => {
  const interpreted = format.interpret(document, context);
  if (Option.isNone(interpreted)) {
    return needsReview("invalid-format");
  }
  const extraction = Schema.decodeOption(TransactionExtraction)({
    money: { amount: interpreted.value.amount, currency: interpreted.value.currency },
    direction: "outflow",
    occurredAt: DateTime.formatIso(interpreted.value.occurredAt),
  });
  if (Option.isNone(extraction)) {
    return needsReview("invalid-format");
  }
  return {
    _tag: "Interpreted",
    extraction: extraction.value,
    evidence: {
      formatId: format.id,
      revision: format.revision,
      currencyBasis: interpreted.value.currencyBasis,
      accountHints: interpreted.value.accountHints,
    },
  };
};

const interpret = (input: InterpretationInput): NotificationEmailInterpretation => {
  const suppliedText = [
    input.content.subject,
    Option.getOrElse(input.content.text, () => ""),
    Option.getOrElse(input.content.html, () => ""),
  ].join("\n");
  if (containsCompleteFinancialNumber(suppliedText)) {
    return needsReview("invalid-format");
  }
  if (Option.isNone(input.content.html)) {
    return needsReview("unsupported-content");
  }
  const document = parseEmailDocument(input.content.html.value);
  if (Option.isNone(document)) {
    return needsReview("unsupported-content");
  }
  if (containsCompleteFinancialNumber(document.value.text)) {
    return needsReview("invalid-format");
  }
  const candidate = selectCandidate(document.value);
  return typeof candidate === "string"
    ? needsReview(candidate)
    : finalizeInterpretation(candidate, document.value, input.context);
};

/**
 * Deterministically interprets bounded provider-decoded email content. The caller supplies captured
 * historical context and may rely on this function never invoking a model, fetching embedded
 * content, logging input, or returning unvalidated facts. Every non-unique or unsafe result is a
 * closed NeedsReview decision.
 */
export const interpretNotificationEmail = Effect.fn("interpretNotificationEmail")(function (
  input: InterpretationInput
): Effect.Effect<NotificationEmailInterpretation> {
  return Effect.sync(() => interpret(input));
});
