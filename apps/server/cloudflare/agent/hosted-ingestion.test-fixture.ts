import { DateTime, Effect, Option, Schema } from "effect";
import { expect } from "vitest";
import * as XLSX from "xlsx/xlsx.mjs";
import { TranscriptText, TranscriptTurnId } from "../../src/core/agent/contract";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppDocument,
  WhatsAppMediaId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { WhatsAppHostedSubject, WhatsAppInboundEvidence } from "../whatsapp/contract";
import { processStatementSubmission } from "../ingestion/operations";
import {
  completeWhatsAppDocumentTurnWithAdmission,
  resumeWhatsAppTurn,
} from "./internal/hosted-turn";
import {
  documentStorage,
  finishLatestWhatsAppFixture,
  inference,
  makeAbortController,
  now,
  setup,
  users,
} from "./hosted-turn.test-fixture";

import type { HostedInferenceService } from "../../src/shell/hosted-inference/contract";
import type { OutboundHttpService } from "../../src/shell/outbound-http/operations";

const accepted = 202;
const ok = 200;
const signedAmount = -45000;
const linkLifetimeMilliseconds = 240000;
type StatementFixture = Readonly<{
  db: D1Database;
  bucket: R2Bucket;
  subject: WhatsAppHostedSubject;
  model: HostedInferenceService;
}>;
const statementBytes = (format: "csv" | "xlsx", hostile: string): Uint8Array<ArrayBuffer> => {
  if (format === "csv") {
    return new TextEncoder().encode(
      `fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,${hostile}\n`
    );
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["fecha", "valor", "moneda", "contraparte"],
      ["2026-08-01", signedAmount, "COP", hostile],
    ]),
    "Movimientos"
  );
  const bytes: unknown = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  if (!(bytes instanceof ArrayBuffer)) throw new Error("Expected XLSX bytes");
  return new Uint8Array(bytes);
};

const prepareFixture = Effect.fnUntraced(function* () {
  const db = yield* Effect.tryPromise(() => setup());
  const { bucket } = yield* Effect.tryPromise(() => documentStorage.acquire());
  yield* Effect.tryPromise(() =>
    db
      .prepare(
        "INSERT INTO whatsapp_identities(user_id,portfolio_id,bsuid,verified_at_ms) VALUES (?,?,?,?)"
      )
      .bind(users[0], "portfolio-1", "CO.13491208655302741918", now())
      .run()
  );
  const subject = WhatsAppHostedSubject.make({
    userId: UserId.make(users[0]),
    portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-1"),
    bsuid: WhatsAppBusinessScopedUserId.make("CO.13491208655302741918"),
  });
  const model = yield* Effect.tryPromise(() =>
    inference(() =>
      Promise.reject(new Error("Known statement extraction must not purchase inference"))
    )
  );
  return { db, bucket, subject, model };
});

const deliver = (): ReturnType<Parameters<typeof resumeWhatsAppTurn>[0]["deliver"]> => ({
  _tag: "WhatsApp",
  contextualReplyQuery: Option.none(),
  send: () =>
    Effect.succeed({
      kind: "accepted",
      messageId: WhatsAppProviderMessageId.make("wamid.synthetic-statement-reply"),
    }),
});

const mediaTransport = (
  format: "csv" | "xlsx",
  bytes: Uint8Array<ArrayBuffer>
): OutboundHttpService => ({
  execute: (request) =>
    Effect.succeed({
      status: ok,
      headers: {},
      body:
        request._tag === "KapsoMediaMetadata"
          ? new TextEncoder().encode(
              JSON.stringify({
                id: "synthetic-statement",
                mime_type:
                  format === "csv"
                    ? "text/csv"
                    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                file_size: bytes.length,
                sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
                download_url:
                  "https://api.kapso.ai/meta/whatsapp/media_download?token=synthetic-private-token",
                download_url_expires_at: DateTime.formatIso(
                  DateTime.makeUnsafe(now() + linkLifetimeMilliseconds)
                ),
              })
            )
          : bytes,
    }),
});

const admitDocument = Effect.fnUntraced(function* (
  fixture: StatementFixture,
  format: "csv" | "xlsx",
  bytes: Uint8Array<ArrayBuffer>
) {
  const response = yield* completeWhatsAppDocumentTurnWithAdmission({
    input: {
      db: fixture.db,
      bucket: Option.some(fixture.bucket),
      subject: fixture.subject,
      document: WhatsAppDocument.make({
        mediaId: WhatsAppMediaId.make("synthetic-statement"),
        fileName: Option.none(),
        caption: Option.none(),
      }),
      outbound: mediaTransport(format, bytes),
      inbound: WhatsAppInboundEvidence.make({
        messageId: WhatsAppProviderMessageId.make("wamid.synthetic-statement"),
        businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
        occurredAtMs: now(),
        receivedAtMs: now(),
        replyToMessageId: Option.none(),
        sandboxPhone: Option.none(),
      }),
      text: TranscriptText.make("Adjunté un extracto."),
      inference: fixture.model,
      executeMutation: Option.none(),
      deliver: deliver(),
      signal: makeAbortController().signal,
      scheduleRecovery: () => Promise.resolve(),
    },
    onAdmitted: () => {},
  });
  expect(response.status).toBe(accepted);
});

const settleDocument = Effect.fnUntraced(function* (fixture: StatementFixture) {
  const { db, bucket, subject, model } = fixture;
  const submission = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
    yield* Effect.tryPromise(() =>
      db.prepare("SELECT id FROM statement_submissions WHERE user_id=?").bind(users[0]).first()
    )
  );
  const work = {
    DB: db,
    STATEMENT_STAGING_BUCKET: bucket,
    userId: users[0],
    submissionId: submission.id,
  };
  expect(yield* processStatementSubmission(work)).toBe("completed");
  expect(yield* processStatementSubmission(work)).toBe("completed");
  const pending = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: TranscriptTurnId }))(
    yield* Effect.tryPromise(() =>
      db
        .prepare("SELECT id FROM hosted_turns WHERE user_id=? AND status='pending'")
        .bind(users[0])
        .first()
    )
  );
  expect(
    (yield* resumeWhatsAppTurn({
      db,
      userId: subject.userId,
      turnId: pending.id,
      bucket: Option.some(bucket),
      outbound: { execute: () => Effect.die("Recovery must not download again") },
      inference: model,
      deliver,
      signal: makeAbortController().signal,
      scheduleRecovery: () => Promise.resolve(),
      onAdmitted: () => {},
    })).status
  ).toBe(accepted);
  yield* finishLatestWhatsAppFixture({ db, subject });
  return { db, submissionId: submission.id };
});

/** Admit synthetic document bytes through the real WhatsApp hosted path, then settle extraction and delivery. */
export const ingestHostileStatement = (
  input: Readonly<{ format: "csv" | "xlsx"; hostile: string }>
): Promise<{ db: D1Database; submissionId: string }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* prepareFixture();
      yield* admitDocument(fixture, input.format, statementBytes(input.format, input.hostile));
      return yield* settleDocument(fixture);
    })
  );
