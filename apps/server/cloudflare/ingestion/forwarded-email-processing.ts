import { consentGranted, consentNotRevoked } from "@fidy/server/consent-runtime";
import { fallbackCaptureCategory } from "@fidy/server/categories";
import { Clock, Data, DateTime, Effect, Option, type PlatformError, Schema } from "effect";
import PostalMime from "postal-mime";
import { ReceivedEmailContent } from "../../src/core/ingestion/model";
import { ReceivedEmailId } from "../../src/core/ingestion/reference";
import { CapturedInterpretationContext } from "../../src/core/interpretation-evidence/contract";
import { ProviderMessageEvidence } from "../../src/core/provider-evidence/contract";
import { encodeMoneyAmount } from "../../src/core/transactions/model";
import {
  type NotificationEmailInterpretation,
  NotificationEmailInterpretationEvidence,
  interpretNotificationEmail,
} from "../../src/shell/ingestion/email-interpretation/interpret";
import { emailCrypto } from "./forwarded-email";

const maximumTimeZoneCharacters = 128;
const Receipt = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  object_key: Schema.String.check(Schema.isPattern(/^email\/v1\/[a-f0-9-]{36}$/u)),
  delivery_digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  byte_length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_048_576 })),
  received_at_ms: Schema.Int,
  expires_at_ms: Schema.Int,
  time_zone: Schema.String.check(Schema.isLengthBetween(1, maximumTimeZoneCharacters)),
});
type Receipt = typeof Receipt.Type;
type Input = Readonly<{
  DB: D1Database;
  EMAIL_BUCKET: Readonly<{
    get: (key: string) => Promise<
      Option.Option<
        Readonly<{
          size: number;
          arrayBuffer: () => Promise<ArrayBuffer>;
        }>
      >
    >;
  }>;
  userId: string;
  receiptId: string;
}>;
type EmailOutcome =
  | NotificationEmailInterpretation
  | Readonly<{
      _tag: "NeedsReview";
      reason: "canonical-validation-failed";
    }>;
type Material = Readonly<{
  digest: string;
  html: Option.Option<string>;
  interpretation: EmailOutcome;
}>;
type Settlement = Readonly<{
  input: Input;
  receipt: Receipt;
  material: Material;
  id: string;
  now: number;
  when: string;
  guard: ReadonlyArray<string | number>;
}>;
const maximumRawBytes = 1_048_576;
const maximumTagCount = 9999;
const hexBase = 16;
class EmailProcessingUnavailable extends Data.TaggedError("EmailProcessingUnavailable")<{
  readonly cause: unknown;
}> {}
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, EmailProcessingUnavailable> =>
  Effect.tryPromise({ try: run, catch: (cause) => new EmailProcessingUnavailable({ cause }) });
const active = `EXISTS (SELECT 1 FROM forwarded_email_receipts r
  WHERE r.id = ? AND r.user_id = ? AND r.state = 'queued' AND r.expires_at_ms > ?
  AND NOT EXISTS (SELECT 1 FROM forwarded_email_outcomes o WHERE o.receipt_id = r.id)
  AND ${consentGranted("r.user_id")}
  AND ${consentNotRevoked("r.user_id")})`;

// Only these fixed HTML tags may leave the personal-evidence boundary; never store tag names
// supplied by the email, attributes, text, URLs, dimensions, or content-dependent lengths.
const structuralTags = ["table", "tr", "td", "p", "span", "div"] as const;
const anonymizeStructure = (html: string): string => {
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

const findOwnedReceipt = (
  input: Input
): Effect.Effect<Option.Option<Receipt>, EmailProcessingUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const raw = yield* attempt(() =>
      input.DB.prepare(`SELECT r.id, r.object_key, r.delivery_digest, r.byte_length,
    r.received_at_ms, r.expires_at_ms, r.time_zone FROM forwarded_email_receipts r
    WHERE r.id = ? AND r.user_id = ? AND r.state = 'queued' AND r.expires_at_ms > ?
      AND ${consentGranted("r.user_id")}
      AND ${consentNotRevoked("r.user_id")}
      AND NOT EXISTS (SELECT 1 FROM forwarded_email_outcomes o WHERE o.receipt_id = r.id)`)
        .bind(input.receiptId, input.userId, current)
        .first()
    );
    if (raw === null) return Option.none();
    return Option.some(yield* Schema.decodeUnknownEffect(Receipt)(raw));
  });

const readBytes = (
  input: Input,
  receipt: Receipt
): Effect.Effect<Uint8Array, EmailProcessingUnavailable> =>
  Effect.gen(function* () {
    const object = yield* attempt(() => input.EMAIL_BUCKET.get(receipt.object_key));
    if (
      Option.isNone(object) ||
      object.value.size !== receipt.byte_length ||
      object.value.size > maximumRawBytes
    ) {
      return yield* new EmailProcessingUnavailable({
        cause: new Error("Email evidence unavailable"),
      });
    }
    const bytes = new Uint8Array(yield* attempt(() => object.value.arrayBuffer()));
    if (bytes.byteLength !== receipt.byte_length) {
      return yield* new EmailProcessingUnavailable({
        cause: new Error("Email evidence unavailable"),
      });
    }
    return bytes;
  });

const decideEmail = (
  parsed: Awaited<ReturnType<typeof PostalMime.parse>>,
  receipt: Receipt
): Effect.Effect<EmailOutcome, Schema.SchemaError> =>
  Effect.gen(function* () {
    const content = Schema.decodeOption(ReceivedEmailContent)({
      receivedEmailId: ReceivedEmailId.make(receipt.id),
      from: parsed.from?.address ?? "",
      to: (parsed.to ?? []).map((recipient) => recipient.address ?? ""),
      subject: parsed.subject ?? "",
      ...(parsed.text === undefined ? {} : { text: parsed.text }),
      ...(parsed.html === undefined ? {} : { html: parsed.html }),
      inlineImages: [],
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(receipt.received_at_ms)),
    });
    if (Option.isNone(content)) {
      return { _tag: "NeedsReview", reason: "canonical-validation-failed" };
    }
    return yield* interpretNotificationEmail({
      content: content.value,
      context: yield* Schema.decodeEffect(CapturedInterpretationContext)({
        serviceMarket: "CO",
        locale: "es-CO",
        timeZone: receipt.time_zone,
      }),
    });
  });

const readMaterial = (
  input: Input,
  receipt: Receipt
): Effect.Effect<Material, EmailProcessingUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const bytes = yield* readBytes(input, receipt);
    const digest = Array.from(
      new Uint8Array(yield* attempt(() => crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)))),
      (byte) => byte.toString(hexBase).padStart(2, "0")
    ).join("");
    if (digest !== receipt.delivery_digest) {
      return yield* new EmailProcessingUnavailable({
        cause: new Error("Email evidence unavailable"),
      });
    }
    // MIME limits mirror admission. No embedded reference is fetched or attachment interpreted.
    const parsed = yield* attempt(() =>
      PostalMime.parse(bytes, {
        maxHeadersSize: 16_384,
        maxNestingDepth: 8,
        maxRfc822NestingDepth: 0,
      })
    );
    if (parsed.attachments.length !== 0) {
      return yield* new EmailProcessingUnavailable({
        cause: new Error("Email evidence unavailable"),
      });
    }
    return {
      digest,
      html: Option.fromUndefinedOr(parsed.html),
      interpretation: yield* decideEmail(parsed, receipt),
    };
  });

const acceptedStatements = (
  settlement: Settlement
): Effect.Effect<
  ReadonlyArray<D1PreparedStatement>,
  Schema.SchemaError | PlatformError.PlatformError
> =>
  Effect.gen(function* () {
    const { input, material, id, when, guard } = settlement;
    if (material.interpretation._tag !== "Interpreted") return [];
    const { extraction, evidence: interpreted } = material.interpretation;
    const evidence = yield* Schema.encodeUnknownEffect(
      Schema.fromJsonString(NotificationEmailInterpretationEvidence)
    )(interpreted);
    const messageEvidence = yield* Schema.encodeUnknownEffect(
      Schema.fromJsonString(ProviderMessageEvidence)
    )({ channel: "email", provider: "cloudflare-email", providerMessageId: input.receiptId });
    return [
      input.DB.prepare(`INSERT INTO transactions (id, user_id, amount, currency,
      direction, counterparty, category_id, notes, occurred_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, ? WHERE ${active}`).bind(
        id,
        input.userId,
        encodeMoneyAmount(extraction.money.amount),
        extraction.money.currency,
        extraction.direction,
        Option.getOrNull(extraction.counterparty),
        fallbackCaptureCategory(extraction.direction),
        DateTime.formatIso(extraction.occurredAt),
        when,
        ...guard
      ),
      input.DB.prepare(`INSERT INTO source_attestations
      (id, user_id, transaction_id, kind, service_market, locale, time_zone,
       interpretation_revision, created_at, received_email_id, message_content_sha256,
       source_format, message_evidence, deterministic_interpretation, extractor_revision)
      SELECT ?, ?, ?, 'notification-email', 'CO', 'es-CO', ?, ?, ?, ?, ?,
        'notification-email', ?, ?, ? WHERE ${active}`).bind(
        yield* emailCrypto.randomUUIDv4,
        input.userId,
        id,
        settlement.receipt.time_zone,
        interpreted.revision,
        when,
        input.receiptId,
        material.digest,
        messageEvidence,
        evidence,
        "forwarded-email-deterministic-v1",
        ...guard
      ),
    ];
  });

const reviewStatement = (settlement: Settlement): D1PreparedStatement => {
  const { input, receipt, material, id, now, guard } = settlement;
  if (material.interpretation._tag !== "NeedsReview") throw new Error("Expected review decision");
  return input.DB.prepare(`INSERT INTO forwarded_email_needs_review
    (id, receipt_id, user_id, reason, created_at_ms, evidence_expires_at_ms)
    SELECT ?, ?, ?, ?, ?, ? WHERE ${active}`).bind(
    id,
    input.receiptId,
    input.userId,
    material.interpretation.reason,
    now,
    receipt.expires_at_ms,
    ...guard
  );
};

const sampleStatement = (
  settlement: Settlement,
  sampleId: string,
  html: string
): D1PreparedStatement =>
  settlement.input.DB.prepare(`INSERT INTO anonymized_email_samples
      (id, service_market, source_format, source_provider, parser_revision,
       anonymization_revision, structure, policy_approved_at_ms, retained_at_ms)
      SELECT ?, 'CO', 'notification-email', 'cloudflare-email', 'cloudflare-mime-v1',
        'structural-tags-v1', ?, ?, ? WHERE ${active}`).bind(
    sampleId,
    anonymizeStructure(html),
    settlement.now,
    settlement.now,
    ...settlement.guard
  );

const settle = (
  input: Input,
  receipt: Receipt,
  material: Material
): Effect.Effect<
  void,
  EmailProcessingUnavailable | Schema.SchemaError | PlatformError.PlatformError
> =>
  Effect.gen(function* () {
    const id = yield* emailCrypto.randomUUIDv4;
    const now = yield* Clock.currentTimeMillis;
    const settlement: Settlement = {
      input,
      receipt,
      material,
      id,
      now,
      when: DateTime.formatIso(DateTime.makeUnsafe(now)),
      guard: [input.receiptId, input.userId, now],
    };
    const statements =
      material.interpretation._tag === "Interpreted"
        ? [...(yield* acceptedStatements(settlement))]
        : [reviewStatement(settlement)];
    // The deterministic, versioned, allowlisted structural transform is the approval policy.
    // Do not retain uncertain/unrecognized email structure indefinitely.
    if (Option.isSome(material.html) && material.interpretation._tag === "Interpreted") {
      const sampleId = yield* emailCrypto.randomUUIDv4;
      statements.push(sampleStatement(settlement, sampleId, material.html.value));
    }
    statements.push(
      input.DB.prepare(`INSERT INTO forwarded_email_outcomes
    (receipt_id, user_id, outcome, transaction_id, review_id, completed_at_ms)
    SELECT ?, ?, ?, ?, ?, ? WHERE ${active}`).bind(
        input.receiptId,
        input.userId,
        material.interpretation._tag === "Interpreted" ? "accepted" : "needs-review",
        material.interpretation._tag === "Interpreted" ? id : null,
        material.interpretation._tag === "NeedsReview" ? id : null,
        now,
        ...settlement.guard
      )
    );
    // A racing revocation or another coordinator cannot commit an orphan result.
    statements.push(
      input.DB.prepare(`INSERT INTO forwarded_email_assertion (id, accepted)
    VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
    ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`)
    );
    yield* attempt(() => input.DB.batch(statements));
  });

/** Finalize one owned delivery under the User coordinator. R2/D1 failure rejects for redelivery;
 * uncertain email becomes visible review. Result, attestation, and outcome commit atomically.
 */
export const processForwardedEmail = (input: Input): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const receipt = yield* findOwnedReceipt(input);
      if (Option.isNone(receipt)) return;
      const material = yield* readMaterial(input, receipt.value);
      yield* settle(input, receipt.value, material);
    })
  ).catch((error: unknown) => {
    if (error instanceof EmailProcessingUnavailable) throw error.cause;
    throw error;
  });
