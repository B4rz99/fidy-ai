import { TranscriptText } from "../../src/core/agent/contract";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";
import { type HostedInferenceService } from "../../src/shell/hosted-inference/contract";
import { seedStatementUploadRefusal } from "./statement-upload.test-fixture";

import { DateTime, Effect, Option, Schema } from "effect";
import { expect, it } from "vitest";

import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppDocument,
  WhatsAppMediaId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { WhatsAppHostedSubject, WhatsAppInboundEvidence } from "../whatsapp/contract";
import {
  assertForeignStatementRead,
  assertQueuedStatement,
  assertRefusedDocument,
  assertSettledStatement,
  assertStatementQuestion,
  confirmStatementWithRecovery,
  documentStorage,
  finishLatestWhatsAppFixture,
  finishStatementExtraction,
  inference,
  makeAbortController,
  now,
  publishStatementWithRecovery,
  reply,
  setup,
  statementClarificationText,
  users,
} from "./hosted-turn.test-fixture";
import {
  completeWhatsAppDocumentTurnWithAdmission,
  completeWhatsAppTurnWithAdmission,
} from "./internal/hosted-turn";

it.each([
  { decision: "resolve", expired: false, name: "resolve", checkpoint: "none", refusal: "none" },
  { decision: "skip", expired: false, name: "skip", checkpoint: "none", refusal: "none" },
  { decision: "abandon", expired: false, name: "abandon", checkpoint: "none", refusal: "none" },
  {
    decision: "resolve",
    expired: true,
    name: "expired session",
    checkpoint: "none",
    refusal: "none",
  },
  {
    decision: "resolve",
    expired: false,
    name: "recovery after consumption",
    checkpoint: "consumed",
    refusal: "none",
  },
  {
    decision: "resolve",
    expired: false,
    name: "recovery after commit",
    checkpoint: "committed",
    refusal: "none",
  },
  {
    decision: "resolve",
    expired: false,
    name: "recovery after outcome",
    checkpoint: "outcome",
    refusal: "none",
  },
  {
    decision: "resolve",
    expired: false,
    name: "attempt-user budget",
    checkpoint: "none",
    refusal: "attempt-user",
  },
  {
    decision: "resolve",
    expired: false,
    name: "attempt-global budget",
    checkpoint: "none",
    refusal: "attempt-global",
  },
  {
    decision: "resolve",
    expired: false,
    name: "User upload budget",
    checkpoint: "none",
    refusal: "user",
  },
  {
    decision: "resolve",
    expired: false,
    name: "global upload budget",
    checkpoint: "none",
    refusal: "global",
  },
  {
    decision: "resolve",
    expired: false,
    name: "upload spend budget",
    checkpoint: "none",
    refusal: "spend",
  },
  {
    decision: "resolve",
    expired: false,
    name: "outstanding upload budget",
    checkpoint: "none",
    refusal: "outstanding",
  },
  {
    decision: "resolve",
    expired: false,
    name: "friendly Free paywall",
    checkpoint: "none",
    refusal: "paywall",
  },
  {
    decision: "resolve",
    expired: false,
    name: "temporary media unavailability",
    checkpoint: "none",
    refusal: "media-unavailable",
  },
  {
    decision: "resolve",
    expired: false,
    name: "publication recovery after staging",
    checkpoint: "none",
    refusal: "none",
    publication: "stage",
  },
  {
    decision: "resolve",
    expired: false,
    name: "publication recovery after commit",
    checkpoint: "none",
    refusal: "none",
    publication: "publication",
  },
  {
    decision: "resolve",
    expired: false,
    name: "publication recovery after outcome",
    checkpoint: "none",
    refusal: "none",
    publication: "outcome",
  },
] as const)(
  "captures clean direct WhatsApp statement rows and settles clarification by $name",
  (testCase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { decision, expired, checkpoint, refusal } = testCase;
        const publication = "publication" in testCase ? (testCase.publication ?? "none") : "none";
        const db = yield* Effect.tryPromise(() => setup());
        const { bucket } = yield* Effect.tryPromise(() => documentStorage.acquire());
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "WITH incoming(user_id,portfolio_id,bsuid,verified_at_ms) AS (VALUES (?,?,?,?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms"
            )
            .bind(users[0], "portfolio-1", "CO.13491208655302741918", now())
            .run()
        );
        const bytes = new TextEncoder().encode(
          "fecha,valor,moneda,contraparte\n2026-08-01,-13000,COP,Cafe\nunknown,unknown,COP,Tienda\n"
        );
        const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        const metadata = {
          id: "direct-statement",
          mime_type: "text/csv",
          file_size: String(bytes.length),
          sha256: digest,
          download_url: "https://api.kapso.ai/meta/whatsapp/media_download?token=signed-token",
          download_url_expires_at: DateTime.formatIso(DateTime.makeUnsafe(now() + 240000)),
        };
        yield* Effect.tryPromise(() =>
          seedStatementUploadRefusal({ db, userId: users[0], current: now(), kind: refusal })
        );
        let mediaRequests = 0;
        let delivered = "";
        let replySequence = 0;
        const sends = ({
          text,
        }: Readonly<{ text: TranscriptText }>): Effect.Effect<{
          kind: "accepted";
          messageId: WhatsAppProviderMessageId;
        }> =>
          Effect.sync(() => {
            delivered = text;
            replySequence += 1;
            return {
              kind: "accepted",
              messageId: WhatsAppProviderMessageId.make(`wamid.statement.reply.${replySequence}`),
            };
          });
        const caller = WhatsAppHostedSubject.make({
          userId: UserId.make(users[0]),
          portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-1"),
          bsuid: WhatsAppBusinessScopedUserId.make("CO.13491208655302741918"),
        });
        const inferenceModel = yield* Effect.tryPromise(() =>
          inference(() => Promise.resolve(reply("unused")))
        );
        const startDocument = (
          database: D1Database
        ): ReturnType<typeof completeWhatsAppDocumentTurnWithAdmission> =>
          completeWhatsAppDocumentTurnWithAdmission({
            input: {
              db: database,
              bucket: Option.some(bucket),
              subject: WhatsAppHostedSubject.make({
                userId: UserId.make(users[0]),
                portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-1"),
                bsuid: WhatsAppBusinessScopedUserId.make("CO.13491208655302741918"),
              }),
              document: WhatsAppDocument.make({
                mediaId: WhatsAppMediaId.make("direct-statement"),
                fileName: Option.none(),
                caption: Option.none(),
              }),
              outbound: {
                execute: (request) => {
                  mediaRequests += 1;
                  return Effect.succeed({
                    status: refusal === "media-unavailable" ? 503 : 200,
                    headers: {},
                    body:
                      request._tag === "KapsoMediaMetadata"
                        ? new TextEncoder().encode(JSON.stringify(metadata))
                        : bytes,
                  });
                },
              },
              inbound: WhatsAppInboundEvidence.make({
                messageId: WhatsAppProviderMessageId.make("wamid.direct-statement"),
                businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
                occurredAtMs: now(),
                receivedAtMs: now(),
                replyToMessageId: Option.none(),
                sandboxPhone: Option.none(),
              }),
              text: TranscriptText.make("Adjunté un extracto."),
              inference: inferenceModel,
              executeMutation: Option.none(),
              deliver: {
                _tag: "WhatsApp",
                contextualReplyQuery: Option.none(),
                send: sends,
              },
              signal: makeAbortController().signal,
              scheduleRecovery: () => Promise.resolve(),
            },
            onAdmitted: () => {},
          });
        const response = yield* publishStatementWithRecovery({
          db,
          bucket,
          checkpoint: publication,
          start: startDocument,
          inference: inferenceModel,
          deliver: () => ({ _tag: "WhatsApp", contextualReplyQuery: Option.none(), send: sends }),
        });
        expect(response.status).toBe(202);
        if (refusal !== "none") {
          yield* assertRefusedDocument({ db, bucket, refusal, mediaRequests, delivered });
          return;
        }
        yield* assertQueuedStatement({ db, mediaRequests, delivered });
        yield* Effect.tryPromise(() => finishStatementExtraction({ db, bucket, userId: users[0] }));
        yield* assertStatementQuestion({
          db,
          bucket,
          inference: inferenceModel,
          deliver: () => ({ _tag: "WhatsApp", contextualReplyQuery: Option.none(), send: sends }),
        });
        yield* finishLatestWhatsAppFixture({ db, subject: caller });
        const review = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT id FROM statement_review_context WHERE user_id=?")
              .bind(users[0])
              .first()
          )
        );
        const extraction = {
          money: { amount: "33000", currency: "COP" },
          counterparty: "Tienda",
          direction: "outflow",
          occurredAt: "2026-08-02T12:00:00.000Z",
        };
        const submission = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT id FROM statement_submissions WHERE user_id=?")
              .bind(users[0])
              .first()
          )
        );
        const operation = {
          resolve: "ingestion__resolveNeedsReviewItem",
          skip: "ingestion__skipNeedsReviewItem",
          abandon: "ingestion__abandonStatementSubmission",
        }[decision];
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "WITH incoming(user_id,portfolio_id,bsuid,verified_at_ms) AS (VALUES (?,?,?,?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms"
            )
            .bind(users[1], "portfolio-1", "CO.13491208655302741919", now())
            .run()
        );
        const foreignCaller = WhatsAppHostedSubject.make({
          userId: UserId.make(users[1]),
          portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-1"),
          bsuid: WhatsAppBusinessScopedUserId.make("CO.13491208655302741919"),
        });
        let foreignRounds = 0;
        const foreignModel = yield* Effect.tryPromise(() =>
          inference(() => {
            foreignRounds += 1;
            return Promise.resolve(
              Response.json({
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: `foreign-statement-${foreignRounds}`,
                          type: "function",
                          function: {
                            name:
                              foreignRounds === 1
                                ? "ingestion__getStatementSubmission"
                                : "ingestion__resolveNeedsReviewItem",
                            arguments: JSON.stringify(
                              foreignRounds === 1
                                ? { params: { id: submission.id } }
                                : { params: { id: review.id }, payload: { extraction } }
                            ),
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
              })
            );
          })
        );
        const foreignResponse = yield* completeWhatsAppTurnWithAdmission({
          input: {
            db,
            subject: foreignCaller,
            bucket: Option.some(bucket),
            inbound: WhatsAppInboundEvidence.make({
              messageId: WhatsAppProviderMessageId.make("wamid.foreign-statement"),
              businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
              occurredAtMs: now(),
              receivedAtMs: now(),
              replyToMessageId: Option.none(),
              sandboxPhone: Option.none(),
            }),
            text: TranscriptText.make("Consulta el extracto."),
            inference: foreignModel,
            executeMutation: Option.none(),
            deliver: {
              _tag: "WhatsApp",
              contextualReplyQuery: Option.none(),
              send: () =>
                Effect.succeed({
                  kind: "accepted" as const,
                  messageId: WhatsAppProviderMessageId.make("wamid.foreign-statement.reply"),
                }),
            },
            signal: makeAbortController().signal,
            scheduleRecovery: () => Promise.resolve(),
          },
          onAdmitted: () => {},
        });
        expect({ status: foreignResponse.status, foreignRounds }).toEqual({
          status: 202,
          foreignRounds: 2,
        });
        yield* finishLatestWhatsAppFixture({ db, subject: foreignCaller });
        yield* assertForeignStatementRead({
          db,
          userId: users[1],
          submissionId: submission.id,
        });
        const foreignChallenge = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ command: TranscriptText })
        )(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT command FROM hosted_confirmations WHERE user_id=?")
              .bind(users[1])
              .first()
          )
        );
        const foreignWrite = yield* completeWhatsAppTurnWithAdmission({
          input: {
            db,
            subject: foreignCaller,
            bucket: Option.some(bucket),
            inbound: WhatsAppInboundEvidence.make({
              messageId: WhatsAppProviderMessageId.make("wamid.foreign-statement.write"),
              businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
              occurredAtMs: now(),
              receivedAtMs: now(),
              replyToMessageId: Option.none(),
              sandboxPhone: Option.none(),
            }),
            text: foreignChallenge.command,
            inference: inferenceModel,
            executeMutation: Option.none(),
            deliver: {
              _tag: "WhatsApp",
              contextualReplyQuery: Option.none(),
              send: () =>
                Effect.succeed({
                  kind: "accepted" as const,
                  messageId: WhatsAppProviderMessageId.make("wamid.foreign-write.reply"),
                }),
            },
            signal: makeAbortController().signal,
            scheduleRecovery: () => Promise.resolve(),
          },
          onAdmitted: () => {},
        });
        expect(foreignWrite.status).toBe(202);
        yield* finishLatestWhatsAppFixture({ db, subject: foreignCaller });
        const refusedWrite = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ outcome_json: Schema.String })
        )(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT outcome_json FROM transcript_entries WHERE user_id=? AND kind='tool_result' AND operation='ingestion.resolveNeedsReviewItem' ORDER BY sequence DESC LIMIT 1"
              )
              .bind(users[1])
              .first()
          )
        );
        expect(refusedWrite.outcome_json).toContain("not_found");
        expect(
          (yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT review_id FROM ingestion_statement_review_decisions WHERE review_id=?"
              )
              .bind(review.id)
              .all()
          )).results
        ).toHaveLength(0);

        expect(
          (yield* Effect.tryPromise(() =>
            db.prepare("SELECT id FROM transactions WHERE user_id=?").bind(users[1]).all()
          )).results
        ).toHaveLength(0);
        const argumentsValue =
          decision === "resolve"
            ? { params: { id: review.id }, payload: { extraction } }
            : { params: { id: decision === "skip" ? review.id : submission.id } };
        const clarifyModel = yield* Effect.tryPromise(() =>
          inference(() =>
            Promise.resolve(
              Response.json({
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "clarify-statement-row",
                          type: "function",
                          function: {
                            name: operation,
                            arguments: JSON.stringify(argumentsValue),
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
              })
            )
          )
        );
        const followUp = ({
          text,
          messageId,
          model,
          phoneNumber,
          database,
        }: Readonly<{
          text: TranscriptText;
          messageId: string;
          model: HostedInferenceService;
          phoneNumber: string;
          database: D1Database;
        }>): ReturnType<typeof completeWhatsAppTurnWithAdmission> =>
          completeWhatsAppTurnWithAdmission({
            input: {
              db: database,
              subject: caller,
              bucket: Option.some(bucket),
              inbound: WhatsAppInboundEvidence.make({
                messageId: WhatsAppProviderMessageId.make(messageId),
                businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make(phoneNumber),
                occurredAtMs: now(),
                receivedAtMs: now(),
                replyToMessageId: Option.none(),
                sandboxPhone: Option.none(),
              }),
              text,
              inference: model,
              executeMutation: Option.none(),
              deliver: { _tag: "WhatsApp", contextualReplyQuery: Option.none(), send: sends },
              signal: makeAbortController().signal,
              scheduleRecovery: () => Promise.resolve(),
            },
            onAdmitted: () => {},
          });
        const factsResponse = yield* followUp({
          database: db,
          text: statementClarificationText(decision),
          messageId: "wamid.statement.facts",
          model: clarifyModel,
          phoneNumber: "123456789",
        });
        expect(factsResponse.status).toBe(202);
        expect(
          (yield* Effect.tryPromise(() =>
            db.prepare("SELECT id FROM transactions WHERE user_id=?").bind(users[0]).all()
          )).results
        ).toHaveLength(1);
        yield* finishLatestWhatsAppFixture({ db, subject: caller });
        const confirmation = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ command: TranscriptText })
        )(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT command FROM hosted_confirmations WHERE user_id=?")
              .bind(users[0])
              .first()
          )
        );
        if (expired) {
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "UPDATE hosted_agent_sessions SET started_at_ms=?,last_activity_at_ms=? WHERE user_id=?"
              )
              .bind(now() - 900_002, now() - 900_001, users[0])
              .run()
          );
          const expiredResponse = yield* followUp({
            database: db,
            text: confirmation.command,
            messageId: "wamid.expired-statement.confirmation",
            model: inferenceModel,
            phoneNumber: "123456789",
          });
          expect(expiredResponse.status).toBe(401);
          expect(
            yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "SELECT clarification_state AS state FROM statement_submissions WHERE clarification_state IS NOT NULL AND user_id=?"
                )
                .bind(users[0])
                .first()
            )
          ).toEqual({ state: "awaiting" });
          // The original evidence deadline, rather than this hosted session, owns review lifetime.
          expect(
            (yield* Effect.tryPromise(() =>
              db.prepare("SELECT id FROM transactions WHERE user_id=?").bind(users[0]).all()
            )).results
          ).toHaveLength(1);
          expect(
            yield* Effect.tryPromise(() =>
              db
                .prepare("SELECT consumed_turn_id FROM hosted_confirmations WHERE user_id=?")
                .bind(users[0])
                .first()
            )
          ).toEqual({ consumed_turn_id: null });
          return;
        }
        const foreignConfirmation = yield* completeWhatsAppTurnWithAdmission({
          input: {
            db,
            subject: foreignCaller,
            bucket: Option.some(bucket),
            inbound: WhatsAppInboundEvidence.make({
              messageId: WhatsAppProviderMessageId.make("wamid.foreign-confirmation"),
              businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
              occurredAtMs: now(),
              receivedAtMs: now(),
              replyToMessageId: Option.none(),
              sandboxPhone: Option.none(),
            }),
            text: confirmation.command,
            inference: inferenceModel,
            executeMutation: Option.none(),
            deliver: {
              _tag: "WhatsApp",
              contextualReplyQuery: Option.none(),
              send: () => Effect.die(new Error("Foreign confirmation must not deliver")),
            },
            signal: makeAbortController().signal,
            scheduleRecovery: () => Promise.resolve(),
          },
          onAdmitted: () => {},
        });
        expect(foreignConfirmation.status).toBe(401);
        expect(
          (yield* Effect.tryPromise(() =>
            db.prepare("SELECT id FROM transactions WHERE user_id=?").bind(users[1]).all()
          )).results
        ).toHaveLength(0);
        const wrongPhone = yield* followUp({
          database: db,
          text: confirmation.command,
          messageId: "wamid.statement.wrong-phone",
          model: inferenceModel,
          phoneNumber: "987654321",
        });
        expect(wrongPhone.status).toBe(401);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT consumed_turn_id FROM hosted_confirmations WHERE user_id=?")
              .bind(users[0])
              .first()
          )
        ).toEqual({ consumed_turn_id: null });
        expect(
          (yield* Effect.tryPromise(() =>
            db.prepare("SELECT id FROM transactions WHERE user_id=?").bind(users[0]).all()
          )).results
        ).toHaveLength(1);
        expect(
          (yield* confirmStatementWithRecovery({
            db,
            bucket,
            checkpoint,
            inference: inferenceModel,
            deliver: () => ({
              _tag: "WhatsApp",
              contextualReplyQuery: Option.none(),
              send: sends,
            }),
            confirm: (database) =>
              followUp({
                database,
                text: confirmation.command,
                messageId: "wamid.statement.confirm",
                model: inferenceModel,
                phoneNumber: "123456789",
              }),
          })).status
        ).toBe(202);
        yield* assertSettledStatement({ db, decision, delivered });
      })
    )
);
