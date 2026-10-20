import {
  type InvalidRecurringEdit,
  RecurringDocument,
  RecurringPlanId,
  RecurringPlanInput,
} from "../../src/core/recurring-plans/contract";
import {
  type HostedInferenceService,
  approvedWorkersAiModel,
} from "../../src/shell/hosted-inference/contract";
import { type UploadRefusalCase } from "./statement-upload.test-fixture";
import { type Cause, Clock, DateTime, Effect, Exit, Option, Schema } from "effect";
import {
  acknowledgeBrowserTurn,
  completeHostedTurn as completeHostedTurnWithAlarm,
  type completeWhatsAppDocumentTurnWithAdmission,
  type completeWhatsAppTurnWithAdmission,
  resumeWhatsAppTurn,
} from "./internal/hosted-turn";
import {
  CanonicalToolOutcome,
  TranscriptText,
  TranscriptTurnId,
} from "../../src/core/agent/contract";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";
import {
  applyRecurringEdit,
  emptyRecurringDocument,
} from "../../src/core/recurring-plans/operations";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { executeStatementExtraction, statementRetention } from "../ingestion/runtime";
import { publicationOutage } from "./statement-publication-recovery.test-fixture";
import { confirmationOutage } from "./statement-recovery.test-fixture";
import { afterAll, afterEach, expect, vi } from "vitest";
import {
  HostedDeliveryCorrelationToken,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { makeCloudflareHostedInference } from "../ai/runtime";
import { installTestSchema, isolatedTestDatabases, isolatedTestStorage } from "../d1-test-fixture";
import { newId } from "../secret-material/operations";
import { UserTransactionCoordinator } from "../transactions/runtime";
import { WhatsAppHostedSubject, WhatsAppInboundEvidence } from "../whatsapp/contract";
import { recordWhatsAppStatus } from "../whatsapp/operations";
import {
  admitHostedTurn,
  finishHostedTurn,
  readHostedSnapshot,
  selectHostedSession,
} from "./internal/turn-store";

export const completeHostedTurn = (
  input: Omit<
    Parameters<typeof completeHostedTurnWithAlarm>[0],
    "scheduleRecovery" | "bucket" | "executeMutation"
  >
): Promise<Response> =>
  Effect.runPromise(
    completeHostedTurnWithAlarm({
      ...input,
      bucket: Option.none(),
      executeMutation: Option.none(),
      scheduleRecovery: () => Promise.resolve(),
    })
  );

export const users = [
  "10000000-0000-4000-8000-000000000071",
  "10000000-0000-4000-8000-000000000072",
] as const;

export const sessions = [
  "10000000-0000-4000-8000-000000000081",
  "10000000-0000-4000-8000-000000000082",
] as const;

const pairings = [
  "10000000-0000-4000-8000-000000000091",
  "10000000-0000-4000-8000-000000000092",
] as const;

export const grants = [
  "10000000-0000-4000-8000-000000000101",
  "10000000-0000-4000-8000-000000000102",
] as const;

const databases = isolatedTestDatabases();

export const now = (): number => Effect.runSync(Clock.currentTimeMillis);

export const digest = (value: string): Promise<Uint8Array> =>
  Effect.runPromise(
    Effect.map(
      Effect.tryPromise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
      (result) => new Uint8Array(result)
    )
  );

export const bearer = (index: number): string => String(index + 1).repeat(43);

export const encodeJson = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

export const decodeJson = (text: string): unknown =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(text);

export const makeAbortController = (): AbortController => new AbortController();

export const waitForToolResult = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Promise<unknown> =>
  vi.waitFor(
    () =>
      db
        .prepare(
          "SELECT e.outcome_json FROM transcript_entries e JOIN hosted_turns t ON t.id=e.turn_id AND t.user_id=e.user_id WHERE e.user_id = ? AND e.kind = 'tool_result' AND t.status = 'failed'"
        )
        .bind(userId)
        .first()
        .then((row) => {
          expect(row).not.toBeNull();
          return row;
        }),
    { timeout: 5_000 }
  );

export const waitForFailedVoice = ({
  db,
  text,
}: Readonly<{ db: D1Database; text: string }>): Promise<void> =>
  vi.waitFor(() =>
    retained({ db, user: users[0] }).then(({ results }) => {
      expect(results).toMatchObject([
        { kind: "user", status: "failed", text },
        { kind: "failed", status: "failed", text: null },
      ]);
    })
  );

export const waitForInterrupted = ({
  db,
  turnId,
}: Readonly<{ db: D1Database; turnId: TranscriptTurnId }>): Promise<void> =>
  vi.waitFor(
    () =>
      db
        .prepare("SELECT status FROM hosted_turns WHERE id = ?")
        .bind(turnId)
        .first()
        .then((row) => {
          expect(row).toMatchObject({ status: "interrupted" });
        }),
    { timeout: 5_000 }
  );

export const promiseGate = (): {
  readonly promise: Promise<void>;
  readonly release: () => void;
} => {
  let release: () => void = () => {};
  const promise = Effect.runPromise(
    Effect.callback<void>((resume): void => {
      release = (): void => resume(Effect.void);
    })
  );
  return { promise, release: (): void => release() };
};

export const setup = (firstGrant: string = grants[0]): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const snapshot = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
      )(currentDisclosureFor());
      const timestamp = now();
      const statements: D1PreparedStatement[] = [];
      for (const index of [0, 1]) {
        const user = users[index];
        const pairing = pairings[index];
        const session = sessions[index];
        const grant = index === 0 ? firstGrant : grants[index];
        if (
          user === undefined ||
          pairing === undefined ||
          session === undefined ||
          grant === undefined
        ) {
          throw Error("fixture");
        }
        statements.push(
          db
            .prepare(
              "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
            )
            .bind(user, timestamp)
        );
        statements.push(
          db
            .prepare(
              "INSERT INTO consent_history (record_type,id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, accepted_at_ms) VALUES ('processing_grant',?, ?, ?, 'disclosed', 'accepted', ?, ?)"
            )
            .bind(grant, user, snapshot, timestamp, timestamp)
        );
        const awaited1 = yield* Effect.tryPromise(() => digest(`verifier${index}`));
        statements.push(
          db
            .prepare(
              "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'consumed', ?, ?)"
            )
            .bind(
              pairing,
              `BCDF-GHJ${index}`,
              awaited1,
              user,
              timestamp - 1_000,
              timestamp + 599_000
            )
        );
        const awaited2 = yield* Effect.tryPromise(() => digest(bearer(index)));
        statements.push(
          db
            .prepare(
              "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(
              session,
              pairing,
              user,
              awaited2,
              timestamp,
              timestamp + 600_000,
              timestamp + 3_600_000,
              timestamp + 7_776_000_000
            )
        );
      }
      yield* Effect.tryPromise(() => db.batch(statements));
      return db;
    })
  );

export const subject = (
  index: number
): Promise<{ userId: string; id: string; digest: Uint8Array }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return {
        userId: users[index] ?? "",
        id: sessions[index] ?? "",
        digest: yield* Effect.tryPromise(() => digest(bearer(index))),
      };
    })
  );

export const reply = (content: unknown = "Listo"): Response =>
  Response.json({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
  });

export const inference = (
  run: (request: unknown) => Promise<Response>
): Promise<HostedInferenceService> =>
  Effect.runPromise(
    makeCloudflareHostedInference({
      AI: { run: (_model, request) => run(request) },
      HOSTED_AI_MODEL: approvedWorkersAiModel,
    })
  );

export const captureReplyAddresses =
  (
    addresses: Array<unknown>
  ): ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) =>
  (input, init) =>
    new Request(input, init).json().then((body) => {
      addresses.push(
        Schema.decodeUnknownSync(
          Schema.Struct({
            to: Schema.optionalKey(Schema.String),
            recipient: Schema.optionalKey(Schema.String),
          })
        )(body)
      );
      return Response.json({
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.queued.answer" }],
      });
    });

export const coordinatorFor = ({
  db,
  run,
  options,
}: Readonly<{
  db: D1Database;
  run: (request: unknown) => Promise<Response>;
  options: Readonly<{ index: number; sandboxPhoneNumberId: string }>;
}>): UserTransactionCoordinator =>
  new UserTransactionCoordinator(
    {
      id: { name: users[options.index] ?? "" },
      storage: {
        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> => Promise.resolve(null),
        deleteAlarm: (): Promise<void> => Promise.resolve(),
        setAlarm: (): Promise<void> => Promise.resolve(),
      },
    },
    {
      DB: db,
      KAPSO_API_KEY: "test-kapso-api-key",
      WHATSAPP_SANDBOX_PHONE_NUMBER_ID: options.sandboxPhoneNumberId,
      HOSTED_AI_MODEL: approvedWorkersAiModel,
      AI: { run: (_model, request) => run(request) },
    }
  );

export const retained = ({
  db,
  user,
}: Readonly<{ db: D1Database; user: string }>): Promise<D1Result> =>
  db
    .prepare(`SELECT t.status, t.failure_reason, e.kind, e.text, e.failure_reason AS marker
  FROM hosted_turns AS t JOIN transcript_entries AS e ON e.turn_id = t.id
  WHERE t.user_id = ? ORDER BY e.sequence`)
    .bind(user)
    .all();

export const VisibleReply = Schema.Struct({
  text: TranscriptText,
  turnId: TranscriptTurnId,
  receipt: Schema.String,
});

export const acknowledgeVisibleReply = ({
  db,
  index,
  response,
}: Readonly<{ db: D1Database; index: number; response: Response }>): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(response.status).toBe(202);
      const visible = yield* Schema.decodeUnknownEffect(VisibleReply)(
        yield* Effect.tryPromise(() => response.json())
      );
      const awaited3 = yield* Effect.tryPromise(() => subject(index));
      const confirmation = yield* acknowledgeBrowserTurn({
        db,
        subject: awaited3,
        turnId: visible.turnId,
        receipt: visible.receipt,
      });
      expect(confirmation.status).toBe(200);
      return visible.text;
    })
  );

afterEach(() => vi.unstubAllGlobals());

afterAll(() => databases.dispose());

export const queuedWhatsAppTurn = ({
  db,
  index,
  text,
}: Readonly<{ db: D1Database; index: 0 | 1; text: string }>): Promise<TranscriptTurnId> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const userId = UserId.make(users[index]);
      const bsuid = WhatsAppBusinessScopedUserId.make(`CO.1349120865530274191${index}`);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            `WITH incoming(user_id,portfolio_id,bsuid,verified_at_ms) AS (VALUES (?, ?, ?, ?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms`
          )
          .bind(userId, "portfolio-1", bsuid, now())
          .run()
      );
      const subject = WhatsAppHostedSubject.make({
        _tag: "WhatsAppHosted",
        userId,
        portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-1"),
        bsuid,
      });
      const snapshot = yield* readHostedSnapshot({ db, subject, now: now() });
      if (Option.isNone(snapshot)) return yield* Effect.die("missing consent");
      const id = TranscriptTurnId.make(newId());
      const admitted = yield* admitHostedTurn({
        db,
        channel: {
          _tag: "WhatsApp",
          subject,
          inbound: WhatsAppInboundEvidence.make({
            messageId: WhatsAppProviderMessageId.make(`wamid.isolation.${index}`),
            replyToMessageId: Option.none(),
            sandboxPhone: Option.none(),
            businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
            occurredAtMs: now(),
            receivedAtMs: now(),
          }),
        },
        selection: selectHostedSession({ snapshot: snapshot.value, userId, now: now() }),
        text: TranscriptText.make(text),
        now: now(),
        id,
      });
      expect(Option.isSome(admitted)).toBe(true);
      return id;
    })
  );

export const retainedChannelState = (db: D1Database): Promise<ReadonlyArray<unknown>> =>
  db
    .batch([
      db.prepare("SELECT * FROM hosted_turns ORDER BY id"),
      db.prepare("SELECT * FROM transcript_entries ORDER BY user_id, sequence"),
      db.prepare(
        "SELECT * FROM (SELECT turn_id,dispatch_user_id AS user_id,dispatch_offered_at_ms AS offered_at_ms,dispatch_created_at_ms AS created_at_ms FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_user_id,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE dispatch_created_at_ms IS NOT NULL) AS hosted_whatsapp_outbox ORDER BY turn_id"
      ),
      db.prepare(
        "SELECT * FROM (SELECT * FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery ORDER BY turn_id"
      ),
    ])
    .then((batches) => batches.map(({ results }) => results));

export const finishLatestWhatsAppFixture = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: WhatsAppHostedSubject }>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT correlation_token,provider_message_id,proposed_at_ms FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery WHERE user_id=? ORDER BY proposed_at_ms DESC,rowid DESC LIMIT 1"
        )
        .bind(subject.userId)
        .first()
    );
    const delivery = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        correlation_token: HostedDeliveryCorrelationToken,
        provider_message_id: WhatsAppProviderMessageId,
        proposed_at_ms: Schema.Int,
      })
    )(row);
    const evidence = yield* recordWhatsAppStatus({
      db,
      userId: subject.userId,
      evidence: {
        correlationToken: delivery.correlation_token,
        businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
        messageEvidence: {
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: delivery.provider_message_id,
        },
        occurredAt: DateTime.makeUnsafe(now()),
        outcome: "delivered",
      },
      receivedAtMs: now(),
    });
    if (Option.isNone(evidence)) return yield* Effect.die("Missing delivered statement reply");
    expect(
      yield* finishHostedTurn({
        db,
        userId: subject.userId,
        turnId: evidence.value.turnId,
        startedAtMs: delivery.proposed_at_ms,
        result: { _tag: "Completed", text: TranscriptText.make(evidence.value.text) },
        subject,
        now: now(),
      })
    ).toBe(true);
  }).pipe(Effect.orDie);

export const documentStorage = isolatedTestStorage();

afterAll(() => documentStorage.dispose());

export const assertForeignStatementRead = ({
  db,
  userId,
  submissionId,
}: Readonly<{ db: D1Database; userId: string; submissionId: string }>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const outcome = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ outcome_json: Schema.String })
    )(
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT outcome_json FROM transcript_entries WHERE user_id=? AND kind='tool_result' AND operation='ingestion.getStatementSubmission'"
          )
          .bind(userId)
          .first()
      )
    );
    expect(outcome.outcome_json).toContain("not_found");
    expect(outcome.outcome_json).not.toContain(submissionId);
    expect(outcome.outcome_json).not.toContain("originalEvidence");
  }).pipe(Effect.orDie);

export const finishStatementExtraction = ({
  db,
  bucket,
  userId,
}: Readonly<{ db: D1Database; bucket: R2Bucket; userId: string }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const submission = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM statement_submissions WHERE user_id=?").bind(userId).first()
        )
      );
      const coordinator = new UserTransactionCoordinator(
        {
          id: { name: userId },
          storage: {
            getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> => Promise.resolve(null),
            deleteAlarm: (): Promise<void> => Promise.resolve(),
            setAlarm: (): Promise<void> => Promise.resolve(),
          },
        },
        {
          DB: db,
          STATEMENT_STAGING_BUCKET: bucket,
          AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
          HOSTED_AI_MODEL: approvedWorkersAiModel,
        }
      );
      yield* Effect.tryPromise(() =>
        executeStatementExtraction({
          payload: { version: 1, userId, submissionId: submission.id },
          coordinator: {
            getByName: (name) => {
              expect(name).toBe(userId);
              return coordinator;
            },
          },
          activity: (_name, _options, run) => run(),
        })
      );
    })
  );

export const assertRefusedDocument = ({
  db,
  bucket,
  refusal,
  mediaRequests,
  delivered,
}: Readonly<{
  db: D1Database;
  bucket: R2Bucket;
  refusal: Exclude<UploadRefusalCase, "none">;
  mediaRequests: number;
  delivered: string;
}>): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const expected = {
      paywall: { requests: 2, message: "cambia a Pro" },
      "media-unavailable": { requests: 1, message: "más tarde" },
      "attempt-user": { requests: 0, message: "límite de cargas" },
      "attempt-global": { requests: 0, message: "límite de cargas" },
      user: { requests: 0, message: "límite de cargas" },
      global: { requests: 0, message: "límite de cargas" },
      spend: { requests: 0, message: "límite de cargas" },
      outstanding: { requests: 0, message: "límite de cargas" },
    }[refusal];
    expect(mediaRequests).toBe(expected.requests);
    expect(delivered).toContain(expected.message);
    expect(delivered).not.toContain("CSV o XLSX válido");
    expect(
      (yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM statement_submissions WHERE user_id=?").bind(users[0]).all()
      )).results
    ).toHaveLength(0);
    expect(
      (yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM transactions WHERE user_id=?").bind(users[0]).all()
      )).results
    ).toHaveLength(0);
    expect((yield* Effect.tryPromise(() => bucket.list())).objects).toHaveLength(
      refusal === "paywall" ? 1 : 0
    );
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT grant_id FROM resource_admission_events WHERE policy_key='ingestion.upload.outstanding.v1' AND scope_key=? AND released_at_epoch_ms IS NULL AND grant_id LIKE 'ingestion-upload-%'"
          )
          .bind(users[0])
          .all()
      )).results
    ).toHaveLength(0);
    if (refusal === "paywall") {
      expect(delivered).toContain("/upgrade");
      const rows = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT outcome_json FROM transcript_entries WHERE user_id=? AND kind='tool_result'"
          )
          .bind(users[0])
          .all()
      );
      const [result] = yield* Schema.decodeUnknownEffect(
        Schema.Tuple([Schema.Struct({ outcome_json: Schema.fromJsonString(CanonicalToolOutcome) })])
      )(rows.results);
      expect(result.outcome_json).toMatchObject({
        _tag: "CanonicalOperationFailed",
        failure: { error: { code: "paywall_required" } },
      });
    }
  });

export const assertQueuedStatement = ({
  db,
  mediaRequests,
  delivered,
}: Readonly<{ db: D1Database; mediaRequests: number; delivered: string }>): Effect.Effect<
  void,
  Cause.UnknownError
> =>
  Effect.gen(function* () {
    expect(mediaRequests).toBe(2);
    expect(delivered).toBe("");
    expect(
      yield* Effect.tryPromise(() =>
        db.prepare("SELECT status FROM hosted_turns WHERE user_id=?").bind(users[0]).first()
      )
    ).toEqual({ status: "pending" });
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT turn_id FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery WHERE user_id=?"
          )
          .bind(users[0])
          .all()
      )).results
    ).toHaveLength(0);
    expect(
      (yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM transactions WHERE user_id=?").bind(users[0]).all()
      )).results
    ).toHaveLength(0);
  });

export const assertSettledStatement = ({
  db,
  decision,
  delivered,
}: Readonly<{
  db: D1Database;
  decision: "resolve" | "skip" | "abandon";
  delivered: string;
}>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    expect(delivered).toContain(decision === "abandon" ? "Se abandonó" : "extracto está listo");
    expect(
      (yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM transactions WHERE user_id=?").bind(users[0]).all()
      )).results
    ).toHaveLength({ resolve: 2, skip: 1, abandon: 1 }[decision]);
    expect(
      (yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM source_attestations WHERE user_id=?").bind(users[0]).all()
      )).results
    ).toHaveLength({ resolve: 2, skip: 1, abandon: 1 }[decision]);
    expect(
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT clarification_state AS state FROM statement_submissions WHERE clarification_state IS NOT NULL AND user_id=?"
          )
          .bind(users[0])
          .first()
      )
    ).toEqual({ state: decision === "abandon" ? "abandoned" : "completed" });
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT turn_id FROM (SELECT rowid,id AS turn_id,user_id,document_media_id AS media_id,document_staging_id AS staging_id,document_upload_grant_id AS upload_grant_id,document_upload_expires_at_ms AS upload_expires_at_ms,document_reference_json AS reference_json,document_created_at_ms AS created_at_ms FROM hosted_turns WHERE document_media_id IS NOT NULL) WHERE user_id=?"
          )
          .bind(users[0])
          .all()
      )).results
    ).toHaveLength(0);
  });

const assertExtractedStatement = ({
  db,
  bucket,
}: Readonly<{ db: D1Database; bucket: R2Bucket }>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    expect(
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT status,published_submission_id FROM statement_staging_objects WHERE user_id=?"
          )
          .bind(users[0])
          .first()
      )
    ).toEqual({ status: "deleting", published_submission_id: null });
    yield* statementRetention({ database: db, bucket, nowEpochMs: now }).sweepStaging.pipe(
      Effect.orDie
    );
    expect((yield* Effect.tryPromise(() => bucket.list())).objects).toHaveLength(0);
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT record_number,reason,issues FROM statement_needs_review WHERE user_id=?")
          .bind(users[0])
          .all()
      )).results
    ).toHaveLength(1);
    expect(
      (yield* Effect.tryPromise(() =>
        db.prepare("SELECT amount,currency FROM transactions WHERE user_id=?").bind(users[0]).all()
      )).results
    ).toEqual([{ amount: "13000", currency: "COP" }]);
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
  });

export const assertStatementQuestion = (
  work: StatementRecoveryFixture
): Effect.Effect<void, Effect.Error<ReturnType<typeof resumeWhatsAppTurn>>> =>
  Effect.gen(function* () {
    yield* assertExtractedStatement(work);
    expect((yield* resumeInterruptedStatement(work)).status).toBe(202);
    const row = yield* Effect.tryPromise(() =>
      work.db
        .prepare(
          "SELECT text AS proposed_text FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery WHERE user_id=?"
        )
        .bind(users[0])
        .first()
    );
    const question = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ proposed_text: Schema.String })
    )(row);
    expect(question.proposed_text).toContain("fila 2");
    expect(question.proposed_text).toContain("indica fecha, importe, moneda");
  });

export type StatementRecoveryFixture = Readonly<{
  db: D1Database;
  bucket: R2Bucket;
  inference: HostedInferenceService;
  deliver: Parameters<typeof resumeWhatsAppTurn>[0]["deliver"];
}>;

const resumeInterruptedStatement = ({
  db,
  bucket,
  inference,
  deliver,
}: StatementRecoveryFixture): ReturnType<typeof resumeWhatsAppTurn> =>
  Effect.gen(function* () {
    const pending = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: TranscriptTurnId }))(
      yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT id FROM hosted_turns WHERE user_id=? AND status='pending'")
          .bind(users[0])
          .first()
      )
    );
    const resumed = yield* resumeWhatsAppTurn({
      onAdmitted: () => {},
      db,
      userId: UserId.make(users[0]),
      turnId: pending.id,
      bucket: Option.some(bucket),
      outbound: { execute: () => Effect.die(new Error("Statement recovery must not download")) },
      inference,
      deliver,
      signal: makeAbortController().signal,
      scheduleRecovery: () => Promise.resolve(),
    });
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT id FROM transcript_entries WHERE user_id=? AND turn_id=? AND kind='tool_call'"
          )
          .bind(users[0], pending.id)
          .all()
      )).results
    ).toHaveLength(1);
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT id FROM transcript_entries WHERE user_id=? AND turn_id=? AND kind='tool_result'"
          )
          .bind(users[0], pending.id)
          .all()
      )).results
    ).toHaveLength(1);
    return resumed;
  });

export const publishStatementWithRecovery = ({
  db,
  bucket,
  checkpoint,
  start,
  inference,
  deliver,
}: Readonly<{
  db: D1Database;
  bucket: R2Bucket;
  checkpoint: "none" | "stage" | "publication" | "outcome";
  start: (database: D1Database) => ReturnType<typeof completeWhatsAppDocumentTurnWithAdmission>;
  inference: HostedInferenceService;
  deliver: Parameters<typeof resumeWhatsAppTurn>[0]["deliver"];
}>): ReturnType<typeof completeWhatsAppDocumentTurnWithAdmission> =>
  Effect.gen(function* () {
    if (checkpoint === "none") return yield* start(db);
    const interrupted = yield* Effect.exit(start(publicationOutage({ db, checkpoint })));
    expect(Exit.isFailure(interrupted)).toBe(true);
    const resumed = yield* resumeInterruptedStatement({ db, bucket, inference, deliver });
    expect(
      (yield* Effect.tryPromise(() =>
        db.prepare("SELECT id FROM statement_submissions WHERE user_id=?").bind(users[0]).all()
      )).results
    ).toHaveLength(1);
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT submission_id FROM (SELECT rowid,id AS submission_id,user_id AS user_id,work_revision AS revision,work_published_at_ms AS published_at_ms,work_last_attempt_at_ms AS last_attempt_at_ms,work_last_reconciled_at_ms AS last_reconciled_at_ms FROM statement_submissions WHERE work_revision IS NOT NULL) AS statement_ingestion_outbox WHERE user_id=?"
          )
          .bind(users[0])
          .all()
      )).results
    ).toHaveLength(1);
    expect((yield* Effect.tryPromise(() => bucket.list())).objects).toHaveLength(1);
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT grant_id FROM resource_admission_events WHERE policy_key='ingestion.upload.user.v1' AND scope_key=?"
          )
          .bind(users[0])
          .all()
      )).results
    ).toHaveLength(1);
    expect(
      (yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT grant_id FROM resource_admission_events WHERE policy_key='ingestion.upload.outstanding.v1' AND scope_key=? AND released_at_epoch_ms IS NULL"
          )
          .bind(users[0])
          .all()
      )).results
    ).toHaveLength(0);
    return resumed;
  });

export const statementClarificationText = (
  decision: "resolve" | "skip" | "abandon"
): TranscriptText =>
  TranscriptText.make(
    decision === "resolve"
      ? "Fila 2: salida de 33000 COP a Tienda el 2 de agosto de 2026."
      : `${decision === "skip" ? "Omitir la fila 2" : "Cancelar lo pendiente del extracto"}.`
  );

export const confirmStatementWithRecovery = ({
  db,
  bucket,
  checkpoint,
  confirm,
  inference,
  deliver,
}: Readonly<{
  db: D1Database;
  bucket: R2Bucket;
  checkpoint: "none" | "consumed" | "committed" | "outcome";
  confirm: (database: D1Database) => ReturnType<typeof completeWhatsAppTurnWithAdmission>;
  inference: HostedInferenceService;
  deliver: Parameters<typeof resumeWhatsAppTurn>[0]["deliver"];
}>): ReturnType<typeof completeWhatsAppTurnWithAdmission> =>
  Effect.gen(function* () {
    if (checkpoint === "none") return yield* confirm(db);
    const interrupted = yield* confirm(confirmationOutage({ db, checkpoint }));
    expect(interrupted.status).toBe(503);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now() + 135_001);
    try {
      return yield* resumeInterruptedStatement({ db, bucket, inference, deliver });
    } finally {
      vi.useRealTimers();
    }
  });

export const runHistoryQueryTurn = (
  db: D1Database
): Effect.Effect<ReadonlyArray<unknown>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const caller = yield* Effect.tryPromise(() => subject(0));
    const requests: Array<unknown> = [];
    const coordinator = coordinatorFor({
      options: { index: 0, sandboxPhoneNumberId: "" },
      db,
      run: (request) => {
        requests.push(request);
        return Promise.resolve(
          requests.length === 1
            ? Response.json({
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [1, 2].map((index) => ({
                        id: `history_${index}`,
                        type: "function",
                        function: {
                          name: "transactions__listTransactions",
                          arguments: '{"query":{}}',
                        },
                      })),
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
              })
            : reply("Historia revisada")
        );
      },
    });
    const response = yield* Effect.tryPromise(() =>
      coordinator.fetch(
        new Request("https://coordinator.internal/hosted-turn", {
          method: "POST",
          body: encodeJson({
            userId: caller.userId,
            sessionId: caller.id,
            digest: Array.from(caller.digest),
            text: "Lee las transacciones guardadas",
          }),
        })
      )
    );
    yield* Effect.tryPromise(() => acknowledgeVisibleReply({ db, index: 0, response }));
    return requests;
  });

export const seedHistoryTransaction = ({
  db,
  counterparty,
}: Readonly<{ db: D1Database; counterparty: string }>): Promise<D1Result> =>
  db
    .prepare(
      "INSERT INTO transactions (id,user_id,amount,currency,direction,counterparty,category_id,occurred_at,created_at) VALUES (?,?,'2500','COP','outflow',?,'10000000-0000-4000-8000-000000000001',?,?)"
    )
    .bind(
      newId(),
      users[0],
      counterparty,
      DateTime.formatIso(DateTime.makeUnsafe(now())),
      DateTime.formatIso(DateTime.makeUnsafe(now()))
    )
    .run();

export const historyUnits = (db: D1Database): Promise<number> =>
  db
    .prepare(
      "SELECT COALESCE(SUM(units),0) AS units FROM commercial_allowance_consumptions WHERE user_id = ? AND allowance = 'hosted_history_turn'"
    )
    .bind(users[0])
    .first<number>("units")
    .then((value) => Option.getOrThrow(Option.fromNullishOr(value)));

export const closedContinuityFixture = Effect.fn(function* (db: D1Database) {
  const caller = yield* Effect.tryPromise(() => subject(0));
  const current = now();
  const snapshot = Option.getOrThrow(
    yield* readHostedSnapshot({ db, subject: caller, now: current })
  );
  const userId = UserId.make(users[0]);
  const selection = selectHostedSession({ snapshot, userId, now: current });
  const turnId = TranscriptTurnId.make(newId());
  yield* admitHostedTurn({
    db,
    channel: { _tag: "Browser", subject: caller },
    selection,
    text: TranscriptText.make("Retained evidence"),
    now: current,
    id: turnId,
  });
  yield* finishHostedTurn({
    db,
    userId,
    turnId,
    startedAtMs: current,
    result: { _tag: "Interrupted" },
    subject: caller,
    now: current,
  });
  return { caller, sessionId: selection.id, current };
});

export const installLifecycleAuditTriggers = (db: D1Database): Promise<unknown> =>
  db.batch([
    db.prepare("CREATE TABLE lifecycle_audit (operation TEXT NOT NULL) STRICT"),
    db.prepare(`CREATE TRIGGER audit_terminal AFTER UPDATE ON hosted_turns
      WHEN OLD.status = 'pending' AND NEW.status <> 'pending'
      BEGIN INSERT INTO lifecycle_audit VALUES ('terminal'); END`),
    db.prepare(`CREATE TRIGGER audit_compaction AFTER DELETE ON transcript_entries
      BEGIN INSERT INTO lifecycle_audit VALUES ('transcript'); END`),
  ]);

export const gateCompactionBatch = (
  db: D1Database
): Readonly<{ db: D1Database; dispatched: Promise<void>; release: () => void }> => {
  const dispatched = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const controlled = new Proxy(db, {
    get(target, property): unknown {
      if (property === "batch") {
        return (
          statements: Parameters<D1Database["batch"]>[0]
        ): ReturnType<D1Database["batch"]> => {
          dispatched.resolve();
          return released.promise.then(() => target.batch(statements));
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: controlled, dispatched: dispatched.promise, release: () => released.resolve() };
};

export const continuityCorruptions = [
  {
    name: "Consent JSON",
    snapshot: true,
    sql: "UPDATE hosted_agent_sessions SET consent_basis_json = '{'",
  },
  {
    name: "tool input JSON",
    snapshot: false,
    sql: "UPDATE transcript_entries SET kind = 'tool_call', text = NULL, iteration = 1, tool_call_id = 'broken', operation = 'transactions.listTransactions', input_json = '{' WHERE kind = 'user'",
  },
  {
    name: "tool outcome JSON",
    snapshot: false,
    sql: "UPDATE transcript_entries SET kind = 'tool_result', text = NULL, iteration = 1, tool_call_id = 'broken', operation = 'transactions.listTransactions', outcome_json = '{' WHERE kind = 'user'",
  },
  {
    name: "out-of-range timestamp",
    snapshot: false,
    sql: "UPDATE transcript_entries SET occurred_at_ms = 9000000000000000 WHERE kind = 'user'",
  },
];

export const seedRecurringReview = ({
  db,
  planId,
}: Readonly<{ db: D1Database; planId: string }>): Effect.Effect<
  void,
  Cause.UnknownError | Schema.SchemaError | InvalidRecurringEdit
> =>
  Effect.gen(function* () {
    const plan = yield* Schema.decodeEffect(RecurringPlanInput)({
      name: "Plan de prueba",
      kind: "expense",
      currency: "COP",
      amountMode: "unknown",
      frequency: "monthly",
      firstDate: "2026-10-15",
      timeZone: "America/Bogota",
    });
    const document = yield* applyRecurringEdit({
      document: emptyRecurringDocument(),
      command: {
        expectedRevision: 0,
        edit: { kind: "create", id: RecurringPlanId.make(planId), plan },
      },
    });
    const encoded = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(RecurringDocument))
    )(document);
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "INSERT INTO user_documents (kind,user_id, document_json, revision) VALUES ('recurring-plan',?, ?, 1)"
        )
        .bind(users[0], encoded)
        .run()
    );
  });
