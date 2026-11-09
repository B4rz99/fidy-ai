import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { UserId } from "../../src/core/identity/contract";
import { WhatsAppProviderMessageId } from "../../src/shell/channels/whatsapp/contract";
import {
  executeCanonicalWork,
  installedHostedStatementOperations,
} from "../canonical-operations/operations";
import { resumeWhatsAppTurn } from "./internal/hosted-turn";
import {
  encodeJson,
  finishLatestWhatsAppFixture,
  inference,
  makeAbortController,
  queuedWhatsAppTurn,
  queuedWhatsAppTurnWithMessage,
  reply,
  seedHistoryTransaction,
  setup,
  users,
  subject as webSubject,
} from "./hosted-turn.test-fixture";
import { WhatsAppHostedSubject } from "../whatsapp/contract";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";

afterEach(() => vi.useRealTimers());

const toolReply = (operation: string, input: unknown): Response =>
  Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "qa-call",
              type: "function",
              function: { name: operation.replace(".", "__"), arguments: encodeJson(input) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
  });

const testCaller = (): Effect.Effect<WhatsAppHostedSubject, Schema.SchemaError> =>
  Schema.decodeEffect(WhatsAppHostedSubject)({
    _tag: "WhatsAppHosted",
    userId: users[0],
    portfolioId: "portfolio-1",
    bsuid: "CO.13491208655302741910",
  });

const exerciseTurn = Effect.fn(function* ({
  db,
  text,
  generate,
  messageId,
}: Readonly<{
  db: D1Database;
  text: string;
  generate: (request: unknown) => Promise<Response>;
  messageId: string;
}>) {
  const turnId = yield* Effect.tryPromise(() =>
    queuedWhatsAppTurnWithMessage({ db, index: 0, text, messageId })
  );
  const model = yield* Effect.tryPromise(() => inference(generate));
  const sent: Array<string> = [];
  const confirmationCommands: Array<string> = [];
  const response = yield* resumeWhatsAppTurn({
    db,
    userId: UserId.make(users[0]),
    turnId,
    bucket: Option.none(),
    outbound: { execute: () => Effect.die("Unexpected media request") },
    inference: model,
    deliver: () => ({
      _tag: "WhatsApp",
      contextualReplyQuery: Option.none(),
      send: ({
        text,
        confirmation,
      }): Effect.Effect<{ kind: "accepted"; messageId: WhatsAppProviderMessageId }> => {
        sent.push(text);
        if (Option.isSome(confirmation)) confirmationCommands.push(confirmation.value.command);
        return Effect.succeed({
          kind: "accepted",
          messageId: WhatsAppProviderMessageId.make(`${messageId}-reply`),
        });
      },
    }),
    signal: makeAbortController().signal,
    scheduleRecovery: () => Promise.resolve(),
    onAdmitted: () => {},
  });
  return { turnId, sent, response, confirmationCommands };
});

const captureInput = {
  payload: {
    money: { amount: "12500", currency: "COP" },
    direction: "outflow",
    occurredAt: "2026-10-01T05:00:00Z",
  },
};

it.each([
  "Gasté 12.500 en un café de prueba QA hoy",
  "12500 café",
  "COP. Registra el gasto de prueba QA1644-1102 y muéstrame la fecha guardada.",
])("withholds a capture confirmation without persistence: %s", (text) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const turnId = yield* Effect.tryPromise(() =>
        queuedWhatsAppTurn({
          db,
          index: 0,
          text,
        })
      );
      const requests: Array<unknown> = [];
      const unsupported = "Registré tu gasto de prueba: 12.500 COP, hoy.";
      const model = yield* Effect.tryPromise(() =>
        inference((request) => {
          requests.push(request);
          return Promise.resolve(reply(unsupported));
        })
      );
      const sent: string[] = [];
      yield* resumeWhatsAppTurn({
        db,
        userId: UserId.make(users[0]),
        turnId,
        bucket: Option.none(),
        outbound: { execute: () => Effect.die("Unexpected media request") },
        inference: model,
        deliver: () => ({
          _tag: "WhatsApp",
          contextualReplyQuery: Option.none(),
          send: ({
            text,
          }): Effect.Effect<{ kind: "accepted"; messageId: WhatsAppProviderMessageId }> => {
            sent.push(text);
            return Effect.succeed({
              kind: "accepted",
              messageId: WhatsAppProviderMessageId.make("wamid.qa-capture-reply"),
            });
          },
        }),
        signal: makeAbortController().signal,
        scheduleRecovery: () => Promise.resolve(),
        onAdmitted: () => {},
      });
      const count = yield* Effect.tryPromise(() =>
        db.prepare("SELECT COUNT(*) AS count FROM transactions").first<number>("count")
      );
      expect(count).toBe(0);
      expect(requests).toHaveLength(1);
      expect(sent).not.toContain(unsupported);
    })
  )
);

it("exposes canonical Transaction capture and retrieval to verified WhatsApp Turns", () => {
  const operations = installedHostedStatementOperations().map(({ id }) => id);
  expect(operations).toEqual(
    expect.arrayContaining([
      "transactions.createTransaction",
      "transactions.listTransactions",
      "transactions.getTransaction",
      "transactions.searchTransactions",
    ])
  );
});

it("commits a WhatsApp capture once, confirms its stored local date, and retrieves it through web and WhatsApp", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.setSystemTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-02T04:43:55Z")));
      const db = yield* Effect.tryPromise(() => setup());
      const turnId = yield* Effect.tryPromise(() =>
        queuedWhatsAppTurn({ db, index: 0, text: "Gasté 12.500 en un café de prueba QA hoy" })
      );
      const input = {
        payload: {
          money: { amount: "12500", currency: "COP" },
          direction: "outflow",
          occurredAt: "2026-11-01T05:00:00Z",
          notes: "café de prueba QA",
        },
      };
      const requests: Array<unknown> = [];
      const model = yield* Effect.tryPromise(() =>
        inference((request) => {
          requests.push(request);
          return Promise.resolve(
            Response.json({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "capture-qa",
                        type: "function",
                        function: {
                          name: "transactions__createTransaction",
                          arguments: encodeJson(input),
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
      const sent: Array<string> = [];
      const delivery: Parameters<typeof resumeWhatsAppTurn>[0]["deliver"] = () => ({
        _tag: "WhatsApp",
        contextualReplyQuery: Option.none(),
        send: ({
          text,
        }): Effect.Effect<{ kind: "accepted"; messageId: WhatsAppProviderMessageId }> => {
          sent.push(text);
          return Effect.succeed({
            kind: "accepted",
            messageId: WhatsAppProviderMessageId.make(`wamid.capture-reply-${sent.length}`),
          });
        },
      });
      const run = (
        id: typeof turnId,
        inferenceModel: typeof model
      ): ReturnType<typeof resumeWhatsAppTurn> =>
        resumeWhatsAppTurn({
          db,
          userId: UserId.make(users[0]),
          turnId: id,
          bucket: Option.none(),
          outbound: { execute: () => Effect.die("Unexpected media request") },
          inference: inferenceModel,
          deliver: delivery,
          signal: makeAbortController().signal,
          scheduleRecovery: () => Promise.resolve(),
          onAdmitted: () => {},
        });
      yield* run(turnId, model);
      expect(requests).toHaveLength(1);
      expect(encodeJson(requests[0])).toContain(
        "La fecha local de hoy en America/Bogota es 2026-11-01"
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("12.500 pesos");
      expect(sent[0]).toContain("1 de noviembre de 2026");
      expect(sent[0]).not.toContain("Referencia:");
      expect(sent[0]).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/u);
      const stored = yield* Effect.tryPromise(() =>
        db.prepare("SELECT id,user_id,amount,currency,category_id FROM transactions").all()
      );
      expect(stored.results).toHaveLength(1);
      expect(stored.results[0]).toMatchObject({
        user_id: users[0],
        amount: "12500",
        currency: "COP",
      });
      const transaction = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, category_id: Schema.String })
      )(stored.results[0]);
      expect(transaction.category_id).not.toBe("");
      expect(sent[0]).not.toContain(transaction.id);
      yield* run(turnId, model);
      expect(sent).toHaveLength(1);
      expect(requests).toHaveLength(1);
      const caller = yield* Schema.decodeEffect(WhatsAppHostedSubject)({
        _tag: "WhatsAppHosted",
        userId: users[0],
        portfolioId: "portfolio-1",
        bsuid: "CO.13491208655302741910",
      });
      yield* finishLatestWhatsAppFixture({ db, subject: caller });
      const web = yield* executeCanonicalWork({
        completion: Option.none(),
        db,
        subject: yield* Effect.tryPromise(() => webSubject(0)),
        current: yield* Clock.currentTimeMillis,
        bucket: Option.none(),
        hostedFence: Option.none(),
        oauthConfirmation: Option.none(),
        inference: Option.none(),
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("transactions.listTransactions"),
          input: { query: { from: "2026-11-01T05:00:00Z", to: "2026-12-01T05:00:00Z" } },
        },
      });
      expect(web.status).toBe(200);
      expect(yield* Effect.tryPromise(() => web.json())).toMatchObject({
        data: [{ id: transaction.id, money: { amount: "12500", currency: "COP" } }],
      });
      const followup = yield* Effect.tryPromise(() =>
        queuedWhatsAppTurnWithMessage({
          db,
          index: 0,
          text: "Muéstrame el gasto de prueba QA",
          messageId: "wamid.qa-retrieve",
        })
      );
      let rounds = 0;
      const reading = yield* Effect.tryPromise(() =>
        inference((request) => {
          rounds += 1;
          if (rounds > 1) {
            expect(encodeJson(request)).toContain(transaction.id);
            return Promise.resolve(reply("El gasto de prueba está guardado."));
          }
          return Promise.resolve(
            Response.json({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "read-qa",
                        type: "function",
                        function: {
                          name: "transactions__getTransaction",
                          arguments: encodeJson({ params: { id: transaction.id } }),
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
      yield* run(followup, reading);
      expect(rounds).toBe(2);
      expect(sent.at(-1)).toBe("El gasto de prueba está guardado.");
      const audit = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT operation,outcome,hosted_turn_id FROM audit_entries WHERE hosted_turn_id IN (?,?) ORDER BY occurred_at_ms,operation"
          )
          .bind(turnId, followup)
          .all()
      );
      expect(audit.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "transactions.createTransaction",
            outcome: "accepted",
            hosted_turn_id: turnId,
          }),
          expect.objectContaining({
            operation: "transactions.getTransaction",
            outcome: "accepted",
            hosted_turn_id: followup,
          }),
        ])
      );
    })
  ));

it("rejects capture after the WhatsApp association changes without partial writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const result = yield* exerciseTurn({
        db,
        text: "Gasté 12500 COP hoy",
        messageId: "wamid.stale-capture",
        generate: () =>
          db
            .prepare("UPDATE users SET whatsapp_bsuid='CO.changed' WHERE id=?")
            .bind(users[0])
            .run()
            .then(() => toolReply("transactions.createTransaction", captureInput)),
      });
      expect(result.sent).toEqual([]);
      for (const table of ["transactions", "source_attestations", "hosted_mutation_commits"]) {
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare(`SELECT count(*) AS count FROM ${table}`).first<number>("count")
          )
        ).toBe(0);
      }
    })
  ));

it("rolls back a failed capture and never delivers the model's success claim", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER qa_capture_failure BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT,'fixture capture failure'); END"
          )
          .run()
      );
      let rounds = 0;
      const result = yield* exerciseTurn({
        db,
        text: "Gasté 12500 COP hoy",
        messageId: "wamid.failed-capture",
        generate: () =>
          Promise.resolve(
            ++rounds === 1
              ? toolReply("transactions.createTransaction", captureInput)
              : reply("Registré tu gasto.")
          ),
      });
      expect(rounds).toBe(1);
      expect(result.sent).toEqual([]);
      expect(result.response.status).toBe(503);
      for (const table of ["transactions", "source_attestations", "hosted_mutation_commits"]) {
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare(`SELECT count(*) AS count FROM ${table}`).first<number>("count")
          )
        ).toBe(0);
      }
    })
  ));

it("withholds another User's Transaction from a WhatsApp canonical read", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => setup());
      const foreignId = "10000000-0000-4000-8000-000000000321";
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,occurred_at_ms,created_at_ms) VALUES (?,?,'12500','COP','outflow','PRIVATE FOREIGN CAPTURE','10000000-0000-4000-8000-000000000001',0,0)"
          )
          .bind(foreignId, users[1])
          .run()
      );
      let rounds = 0;
      const result = yield* exerciseTurn({
        db,
        text: "Muéstrame ese movimiento",
        messageId: "wamid.foreign-read",
        generate: (request) => {
          rounds += 1;
          if (rounds > 1) {
            expect(encodeJson(request)).toContain("not_found");
            expect(encodeJson(request)).not.toContain("PRIVATE FOREIGN CAPTURE");
            return Promise.resolve(reply("No encontré ese movimiento."));
          }
          return Promise.resolve(
            toolReply("transactions.getTransaction", { params: { id: foreignId } })
          );
        },
      });
      expect(rounds).toBe(2);
      expect(result.sent).toEqual(["No encontré ese movimiento."]);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM hosted_mutation_commits").first<number>("count")
        )
      ).toBe(0);
    })
  ));

it.each(["transactions.updateTransaction", "transactions.deleteTransaction"] as const)(
  "requires exact confirmation for WhatsApp %s and executes it only once",
  (operation) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        yield* Effect.tryPromise(() => seedHistoryTransaction({ db, counterparty: "QA" }));
        const id = yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM transactions LIMIT 1").first<string>("id")
        );
        if (id === null) return yield* Effect.die("Missing fixture Transaction");
        const input =
          operation === "transactions.updateTransaction"
            ? {
                params: { id },
                payload: { expectedRevision: 0, changes: { notes: "QA corrected" } },
              }
            : { params: { id } };
        const proposal = yield* exerciseTurn({
          db,
          text: "Corrige o elimina la transacción de prueba",
          messageId: "wamid.confirm-proposal",
          generate: () => Promise.resolve(toolReply(operation, input)),
        });
        expect(proposal.sent).toHaveLength(1);
        expect(proposal.sent[0]).toContain("Toca Confirmar");
        expect(proposal.confirmationCommands).toHaveLength(1);
        expect(proposal.sent[0]).not.toContain(proposal.confirmationCommands[0]);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT revision FROM transactions WHERE id=?")
              .bind(id)
              .first<number>("revision")
          )
        ).toBe(0);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT deleted_at_ms FROM transactions WHERE id=?")
              .bind(id)
              .first<number>("deleted_at_ms")
          )
        ).toBeNull();
        yield* finishLatestWhatsAppFixture({ db, subject: yield* testCaller() });
        const command = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT command FROM hosted_confirmations WHERE issued_turn_id=?")
            .bind(proposal.turnId)
            .first<string>("command")
        );
        if (command === null) return yield* Effect.die("Missing confirmation command");
        const accepted = yield* exerciseTurn({
          db,
          text: command,
          messageId: "wamid.confirm-accepted",
          generate: () =>
            Promise.reject(new Error("Exact confirmation must not purchase inference")),
        });
        expect(accepted.sent).toHaveLength(1);
        if (operation === "transactions.updateTransaction") {
          expect(
            yield* Effect.tryPromise(() =>
              db.prepare("SELECT notes,revision FROM transactions WHERE id=?").bind(id).first()
            )
          ).toMatchObject({ notes: "QA corrected", revision: 1 });
        } else {
          expect(
            yield* Effect.tryPromise(() =>
              db
                .prepare("SELECT deleted_at_ms FROM transactions WHERE id=?")
                .bind(id)
                .first<number>("deleted_at_ms")
            )
          ).not.toBeNull();
        }
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT count(*) AS count FROM hosted_mutation_commits")
              .first<number>("count")
          )
        ).toBe(1);
        yield* finishLatestWhatsAppFixture({ db, subject: yield* testCaller() });
        const replay = yield* exerciseTurn({
          db,
          text: command,
          messageId: "wamid.confirm-replay",
          generate: () =>
            Promise.reject(new Error("Consumed confirmation must not purchase inference")),
        });
        expect(replay.sent).toEqual([]);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT count(*) AS count FROM hosted_mutation_commits")
              .first<number>("count")
          )
        ).toBe(1);
      })
    )
);
