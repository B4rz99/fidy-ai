import { localHostedCatalog } from "../canonical-operations/operations";
import { completeHostedClarification } from "./clarification.test-fixture";
import {
  type ReviewCommand,
  statementStagingLifetimeMilliseconds,
} from "../../src/core/ingestion/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Data, Effect, Option, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { alice, seed } from "../financial-user-store.test-fixture";
import { native, nativeBillingPlatform } from "../user-store.test-fixture";

import { batchCallId } from "./statement-batch.test-fixture";
import { type StatementCoordinatorActivity } from "./contract";

const CoordinatorWire = Data.taggedEnum<typeof StatementCoordinatorActivity.Encoded>();

const ReviewWire = Data.taggedEnum<typeof ReviewCommand.Encoded>();

const storedText = Schema.decodeUnknownSync(Schema.String);

const documentJourney = Effect.fn(function* (mediaId: string = "media_statement_123") {
  const runtime = yield* (yield* nativeBillingPlatform)(undefined, [], {
    OPENAI_API_KEY: "fixture-openai",
    HOSTED_AI_MODEL: "gpt-6-luna",
  });

  const owner = yield* seed(runtime, alice, false);

  const bsuid = "CO.13491208655302741918",
    portfolio = "123456789012345";

  yield* owner.exec(
    "UPDATE users SET whatsapp_portfolio_id=?,whatsapp_bsuid=?,whatsapp_verified_at_ms=? WHERE id=?",
    portfolio,
    bsuid,
    owner.now,
    alice.user
  );
  yield* owner.exec(
    "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES('22460000-0000-4000-8000-000000000010',?,'processing_grant',?,?)",
    alice.user,
    owner.now,
    yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(currentDisclosureFor())
  );
  yield* native(() =>
    owner.directory.exec(
      "INSERT INTO whatsapp_routes(portfolio,bsuid,user_id,attempt_id,established) VALUES (?,?,?,?,1)",
      portfolio,
      bsuid,
      alice.user,
      "fixture-attempt"
    )
  );

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    message: {
      id: "wamid.native.statement",
      timestamp: String(Math.floor(owner.now / 1000)),
      type: "document",
      from_user_id: bsuid,
      document: { id: mediaId, filename: "estado.csv" },
    },
    conversation: { business_scoped_user_id: bsuid },
    phone_number_id: portfolio,
  });

  const signature = new Bun.CryptoHasher("sha256", "callback-fixture-secret")
    .update(body)
    .digest("hex");

  const deliver = (): Effect.Effect<Awaited<ReturnType<typeof runtime.dispatchFetch>>> =>
    native(() =>
      runtime.dispatchFetch("https://api.fidyapp.com/providers/kapso/callback", {
        method: "POST",
        headers: {
          "x-webhook-event": "whatsapp.message.received",
          "x-webhook-signature": signature,
          "x-idempotency-key": "document-delivery",
        },
        body,
      })
    );

  const holdUnboundStage = Effect.fnUntraced(function* () {
    const id = "22460000-0000-4000-8000-000000000017",
      at = Math.floor(owner.now / 1000) * 1000;

    yield* owner.exec(
      "INSERT INTO statement_documents VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,0,0)",
      id,
      alice.user,
      portfolio,
      bsuid,
      "wamid.native.statement",
      portfolio,
      mediaId,
      at,
      owner.now,
      at + statementStagingLifetimeMilliseconds,
      "users/" + alice.user + "/staging/statement/v1/" + id,
      owner.now
    );
    yield* owner.exec("INSERT INTO statement_backfill VALUES(?,?,NULL)", alice.user, id);
  });

  return { runtime, owner, deliver, holdUnboundStage };
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "resumes an unbound private statement stage and resolves its review through published entrypoints",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, deliver, holdUnboundStage } = yield* documentJourney();
        yield* holdUnboundStage();
        expect((yield* deliver()).status).toBe(202);
        expect((yield* deliver()).status).toBe(202);

        const rows = yield* owner
          .exec("SELECT status,processed_review_rows FROM statement_submissions")
          .pipe(
            Effect.filterOrFail(
              (rows) => rows[0]?.status === "completed",
              () => "pending" as const
            ),
            Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
          );

        expect(rows).toEqual([{ status: "completed", processed_review_rows: 2 }]);
        yield* owner.exec(
          "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO ingestion_review_items(id,user_id,source_kind,statement_submission_id,record_number,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,issues_json,evidence_state) SELECT '90000000-0000-4000-8000-'||printf('%012d',x),user_id,'statement',statement_submission_id,x+2,reason,created_at_ms,1,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,issues_json,'expired' FROM ingestion_review_items,n WHERE record_number=1"
        );

        const plan = yield* owner.exec(
          "EXPLAIN QUERY PLAN SELECT count(*) FROM ingestion_review_sources WHERE user_id=? AND status='pending' AND expires_at_ms>?",
          alice.user,
          owner.now
        );

        expect(plan.map((entry) => storedText(entry.detail)).join(" ")).toContain(
          "ingestion_review_page"
        );

        const response = yield* native(() =>
          runtime.dispatchFetch(
            "https://api.fidyapp.com/ingestion/needs-review?status=pending&limit=1",
            {
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: "__Host-fidy_session=" + alice.bearer,
                "Fidy-Session-Binding": alice.session,
              },
            }
          )
        );

        expect(response.status).toBe(200);

        const page = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                submissionId: Schema.String,
                status: Schema.Literal("pending"),
                sourceFormat: Schema.Literal("csv"),
              })
            ),
          })
        )(yield* native(() => response.json()));

        expect(page.data).toHaveLength(1);
        const [item] = page.data;

        if (item === undefined) return yield* Effect.die("Expected one review item");

        const api = (
          path: string,
          method = "GET",
          payload?: unknown
        ): Effect.Effect<Awaited<ReturnType<typeof runtime.dispatchFetch>>> =>
          native(() =>
            runtime.dispatchFetch("https://api.fidyapp.com" + path, {
              method,
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: "__Host-fidy_session=" + alice.bearer,
                "Fidy-Session-Binding": alice.session,
                "content-type": "application/json",
              },
              ...Option.match(Option.fromUndefinedOr(payload), {
                onNone: () => ({}),
                onSome: (payload) => ({ body: JSON.stringify(payload) }),
              }),
            })
          );

        const history = yield* api("/ingestion/review-workspace?status=expired&limit=0");
        expect(yield* native(() => history.json())).toMatchObject({
          data: { pendingCount: 2, total: 10000, items: [] },
        });
        yield* owner.exec("DELETE FROM ingestion_review_items WHERE evidence_expires_at_ms=1");
        const material = yield* api("/ingestion/review-workspace/" + item.id + "/material");
        expect(material.status).toBe(200);
        expect(yield* native(() => material.json())).toMatchObject({ data: { available: true } });

        const resolve = (): Effect.Effect<Awaited<ReturnType<typeof runtime.dispatchFetch>>> =>
          api("/ingestion/needs-review/" + item.id + "/resolve", "POST", {
            extraction: {
              money: { amount: "8.50", currency: "USD" },
              occurredAt: "2025-11-01T18:00:00.000Z",
              direction: "outflow",
            },
          });

        yield* owner.exec(
          "CREATE TRIGGER fail_resolution_audit BEFORE INSERT ON audit_entries WHEN NEW.operation='ingestion.resolveNeedsReviewItem' BEGIN SELECT RAISE(ABORT,'fixture'); END"
        );
        expect((yield* resolve()).status).toBe(503);
        expect(yield* owner.exec("SELECT count(*) AS n FROM source_attestations")).toEqual([
          { n: 0 },
        ]);
        yield* owner.exec("DROP TRIGGER fail_resolution_audit");
        const resolved = yield* resolve();
        expect(resolved.status).toBe(200);

        const abandoned = yield* api("/operations/atomic-batch", "POST", {
          calls: [
            {
              callId: batchCallId(1),
              operation: "ingestion.abandonStatementSubmission",
              input: { params: { id: item.submissionId } },
            },
          ],
        });

        expect(abandoned.status).toBe(200);
        expect(yield* native(() => abandoned.json())).toMatchObject({
          data: {
            results: [
              {
                output: {
                  data: {
                    status: "abandoned",
                    accounting: {
                      acceptedRows: 1,
                      needsReviewRows: 0,
                      abandonedRows: 1,
                      inputRows: 2,
                    },
                  },
                },
              },
            ],
          },
        });
        expect(
          yield* owner.exec(
            "SELECT kind,statement_submission_id,source_format FROM source_attestations WHERE user_id=?",
            alice.user
          )
        ).toEqual([
          {
            kind: "statement-line",
            statement_submission_id: item.submissionId,
            source_format: "csv",
          },
        ]);
      })
  );
  test.effect(
    "erases unadmitted statement bytes and releases the Free grant after withdrawal",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, deliver } = yield* documentJourney();
        yield* owner.exec(
          "CREATE TRIGGER stop_publication BEFORE INSERT ON statement_submissions BEGIN SELECT RAISE(ABORT,'fixture'); END"
        );
        expect((yield* deliver()).status).toBe(503);
        const [row] = yield* owner.exec("SELECT object_key FROM statement_documents");
        const key = storedText(row?.object_key);
        const bucket = yield* native(() => runtime.getR2Bucket("STATEMENT_STAGING_BUCKET", "core"));
        expect(yield* native(() => bucket.head(key))).not.toBeNull();
        yield* owner.exec("DROP TRIGGER stop_publication");
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,record_type,grant_record_id,session_id,occurred_at_ms) VALUES('withdraw',?,'processing_withdrawal','22460000-0000-4000-8000-000000000010',?,?)",
          alice.user,
          alice.session,
          owner.now
        );
        yield* owner.exec("UPDATE statement_documents SET last_stage_attempt_at_ms=0");
        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
        expect(
          (yield* native(() =>
            users
              .getByName(alice.user)
              .fetch("https://owner.internal/work/check", { method: "POST" })
          )).status
        ).toBe(204);
        yield* owner.exec("SELECT disposition FROM statement_documents").pipe(
          Effect.filterOrFail(
            (rows) => rows[0]?.disposition === 2,
            () => "undisposed" as const
          ),
          Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
        );
        expect(yield* native(() => bucket.head(key))).toBeNull();
        expect(yield* owner.exec("SELECT id FROM statement_submissions")).toEqual([]);
        expect(yield* owner.exec("SELECT submission_id FROM statement_backfill")).toEqual([]);
      })
  );
  test.effect("recovers a retained statement after its first Queue handoffs exhaust retries", () =>
    Effect.gen(function* () {
      const { runtime, owner, deliver } = yield* documentJourney();
      yield* owner.exec(
        "CREATE TRIGGER interrupt_lookup AFTER INSERT ON statement_submissions BEGIN UPDATE statement_submissions SET service_market='unavailable' WHERE id=NEW.id; END"
      );
      expect((yield* deliver()).status).toBe(202);
      const [submission] = yield* owner.exec("SELECT id FROM statement_submissions");
      const id = storedText(submission?.id);

      const dead = yield* native(() =>
        runtime.getR2Bucket("QUEUE_DIAGNOSTICS", "private-email-fixture")
      );

      yield* native(() => dead.head(id)).pipe(
        Effect.filterOrFail(
          (object) => object !== null,
          () => "handoff not exhausted" as const
        ),
        Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
      );
      expect(
        yield* owner.exec(
          "SELECT status,work_published_at_ms IS NOT NULL AS pending FROM statement_submissions"
        )
      ).toEqual([{ status: "queued", pending: 1 }]);
      yield* owner.exec("DROP TRIGGER interrupt_lookup");
      yield* owner.exec(
        "UPDATE statement_submissions SET service_market='CO',work_last_attempt_at_ms=0"
      );
      const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
      expect(
        (yield* native(() =>
          users.getByName(alice.user).fetch("https://owner.internal/work/check", { method: "POST" })
        )).status
      ).toBe(204);
      yield* owner.exec("SELECT status FROM statement_submissions").pipe(
        Effect.filterOrFail(
          (rows) => rows[0]?.status === "completed",
          () => "not recovered" as const
        ),
        Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
      );
      expect(yield* owner.exec("SELECT count(*) AS n FROM ingestion_review_items")).toEqual([
        { n: 2 },
      ]);
    })
  );
  test.effect(
    "resumes interrupted publication and extraction at the original deadline with exact queued authority",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, deliver } = yield* documentJourney();
        yield* owner.exec(
          "CREATE TRIGGER stop_publication BEFORE INSERT ON statement_submissions BEGIN SELECT RAISE(ABORT,'fixture'); END"
        );
        expect((yield* deliver()).status).toBe(503);

        const [staged] = yield* owner.exec(
          "SELECT id,object_key,expires_at_ms FROM statement_documents"
        );

        if (staged === undefined) return yield* Effect.die("Expected staged document");
        const bucket = yield* native(() => runtime.getR2Bucket("STATEMENT_STAGING_BUCKET", "core"));
        const original = yield* native(() => bucket.head(storedText(staged.object_key)));
        expect(original?.size).toBeGreaterThan(0);
        expect(yield* owner.exec("SELECT id FROM statement_submissions")).toEqual([]);
        yield* owner.exec("DROP TRIGGER stop_publication");
        yield* owner.exec(
          "CREATE TRIGGER stop_extraction BEFORE INSERT ON ingestion_review_items BEGIN SELECT RAISE(ABORT,'fixture'); END"
        );
        yield* owner.exec("UPDATE statement_documents SET last_stage_attempt_at_ms=0");
        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

        const maintenance = yield* native(() =>
          users.getByName(alice.user).fetch("https://owner.internal/work/check", { method: "POST" })
        );

        expect(maintenance.status).toBe(204);
        yield* owner.exec("SELECT materialized_rows FROM statement_submissions").pipe(
          Effect.filterOrFail(
            (rows) => rows[0]?.materialized_rows === 2,
            () => "waiting" as const
          ),
          Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
        );
        expect(yield* owner.exec("SELECT count(*) AS n FROM ingestion_review_items")).toEqual([
          { n: 0 },
        ]);

        const [submission] = yield* owner.exec(
          "SELECT retention_expires_at_ms FROM statement_submissions"
        );

        expect(submission?.retention_expires_at_ms).toBe(staged.expires_at_ms);
        expect((yield* native(() => bucket.head(storedText(staged.object_key))))?.etag).toBe(
          original?.etag
        );
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,record_type,grant_record_id,session_id,occurred_at_ms) VALUES('withdraw',?,'processing_withdrawal','22460000-0000-4000-8000-000000000010',?,?)",
          alice.user,
          alice.session,
          owner.now
        );
        expect((yield* deliver()).status).toBe(403);
        yield* owner.exec("DROP TRIGGER stop_extraction");
        const ns = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

        const activity = (
          id: string
        ): Effect.Effect<Awaited<ReturnType<ReturnType<typeof ns.getByName>["fetch"]>>> =>
          native(() =>
            ns.getByName(alice.user).fetch("https://coordinator.internal/statement-work", {
              method: "POST",
              body: JSON.stringify(
                CoordinatorWire.StatementWork({ version: 1, userId: alice.user, submissionId: id })
              ),
            })
          );

        expect((yield* activity("30000000-0000-4000-8000-000000000044")).status).toBe(200);
        expect((yield* activity(storedText(staged.id))).status).toBe(200);
        expect((yield* activity(storedText(staged.id))).status).toBe(200);
        expect(
          yield* owner.exec(
            "SELECT processed_rows,source_parse_attempts FROM statement_submissions"
          )
        ).toEqual([{ processed_rows: 2, source_parse_attempts: 1 }]);

        const read = yield* native(() =>
          runtime.dispatchFetch("https://api.fidyapp.com/ingestion/review-workspace", {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: "__Host-fidy_session=" + alice.bearer,
              "Fidy-Session-Binding": alice.session,
            },
          })
        );

        expect([401, 403]).toContain(read.status);
        expect(yield* owner.exec("SELECT count(*) AS n FROM ingestion_review_items")).toEqual([
          { n: 2 },
        ]);
      })
  );

  test.effect("offers publication only under verified WhatsApp authority", () =>
    Effect.sync(() => {
      expect(localHostedCatalog("verified-whatsapp").map((op) => op.id)).toContain(
        "ingestion.submitForExtraction"
      );
      expect(localHostedCatalog("no-verified-whatsapp-authority").map((op) => op.id)).not.toContain(
        "ingestion.submitForExtraction"
      );
    })
  );

  const verifyHostedOrigin = Effect.fnUntraced(function* (batched: boolean) {
    const { owner, runtime, deliver } = yield* documentJourney();
    expect((yield* deliver()).status).toBe(202);

    const [item] = yield* owner
      .exec(
        "SELECT r.id,s.id AS submission,s.hosted_session_id,s.hosted_turn_id,s.hosted_expires_at_ms FROM ingestion_review_items r JOIN statement_submissions s ON s.id=r.statement_submission_id"
      )
      .pipe(
        Effect.filterOrFail(
          (rows) => rows.length === 2,
          () => "pending" as const
        ),
        Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
      );

    if (item === undefined) return yield* Effect.die("Missing hosted row");

    const [reply] = yield* owner
      .exec("SELECT answer FROM hosted_turns WHERE answer IS NOT NULL")
      .pipe(
        Effect.filterOrFail(
          (rows) => rows.length === 1,
          () => "waiting for exact statement"
        ),
        Effect.retry({ times: 80, schedule: Schedule.spaced("50 millis") })
      );

    expect(reply?.answer).toContain("fila 1");
    expect(yield* owner.exec("SELECT operation,outcome FROM hosted_tool_calls")).toEqual([
      { operation: "ingestion.submitForExtraction", outcome: "Succeeded" },
    ]);

    const [origin] = yield* owner.exec(
      "SELECT o.session_id,o.turn_id,o.expires_at_ms FROM statement_document_origins o JOIN hosted_turns t ON t.id=o.turn_id AND t.session_id=o.session_id AND t.user_id=o.user_id JOIN hosted_agent_sessions s ON s.id=t.session_id AND s.user_id=t.user_id WHERE o.message='wamid.native.statement' AND o.user_id=?",
      alice.user
    );

    expect(origin).toBeDefined();
    expect(item).toMatchObject({
      hosted_session_id: origin?.session_id,
      hosted_turn_id: origin?.turn_id,
      hosted_expires_at_ms: origin?.expires_at_ms,
    });

    const invoke = (
      path: string,
      payload?: unknown
    ): Effect.Effect<Awaited<ReturnType<typeof runtime.dispatchFetch>>> =>
      native(() =>
        runtime.dispatchFetch("https://api.fidyapp.com/" + path, {
          method: "POST",
          headers: {
            origin: "https://app.fidyapp.com",
            cookie: "__Host-fidy_session=" + alice.bearer,
            "Fidy-Session-Binding": alice.session,
            "content-type": "application/json",
          },
          ...Option.match(Option.fromUndefinedOr(payload), {
            onNone: () => ({}),
            onSome: (payload) => ({ body: JSON.stringify(payload) }),
          }),
        })
      );

    expect((yield* invoke("ingestion/needs-review/" + storedText(item.id) + "/skip")).status).toBe(
      404
    );
    expect(
      (yield* invoke("ingestion/statements/" + storedText(item.submission) + "/abandon")).status
    ).toBe(404);
    expect(
      (yield* invoke(
        "ingestion/review-workspace/edits",
        ReviewWire.Skip({ items: [{ id: storedText(item.id), revision: 0 }] })
      )).status
    ).toBeGreaterThanOrEqual(400);
    expect(
      yield* owner.exec("SELECT workspace_revision FROM ingestion_review_items WHERE id=?", item.id)
    ).toEqual([{ workspace_revision: null }]);
    yield* completeHostedClarification(runtime, owner, { item: storedText(item.id), batched });
  });

  test.effect("ties statement decisions to the originating Hosted Agent Session and Turn", () =>
    verifyHostedOrigin(false)
  );
  test.effect(
    "confirms a signed WhatsApp batch against its originating statement and commits both owners",
    () => verifyHostedOrigin(true)
  );
  test.effect(
    "captures a clean line once and retains its consumed Free grant when the ambiguous line is skipped",
    () =>
      Effect.gen(function* () {
        const { owner, runtime, deliver, holdUnboundStage } =
          yield* documentJourney("media_statement_mixed");

        yield* holdUnboundStage();
        expect((yield* deliver()).status).toBe(202);

        const [record] = yield* owner
          .exec(
            "SELECT id,status,processed_accepted_rows,processed_review_rows FROM statement_submissions"
          )
          .pipe(
            Effect.filterOrFail(
              (xs) => xs[0]?.status === "completed",
              () => "pending" as const
            ),
            Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
          );

        expect(record).toMatchObject({ processed_accepted_rows: 1, processed_review_rows: 1 });
        expect((yield* deliver()).status).toBe(202);
        expect(
          yield* owner.exec("SELECT statement_record_number,kind FROM source_attestations")
        ).toEqual([{ statement_record_number: 1, kind: "statement-line" }]);
        const [item] = yield* owner.exec("SELECT id FROM ingestion_review_items");

        if (item === undefined) return yield* Effect.die("Expected ambiguous line");

        const skip = yield* native(() =>
          runtime.dispatchFetch(
            "https://api.fidyapp.com/ingestion/needs-review/" + storedText(item.id) + "/skip",
            {
              method: "POST",
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: "__Host-fidy_session=" + alice.bearer,
                "Fidy-Session-Binding": alice.session,
              },
            }
          )
        );

        expect(skip.status).toBe(200);
        expect(yield* owner.exec("SELECT clarification_state FROM statement_submissions")).toEqual([
          { clarification_state: "completed" },
        ]);
        expect(
          yield* owner.exec(
            "SELECT count(*) AS n FROM statement_backfill WHERE consumed_at_ms IS NOT NULL"
          )
        ).toEqual([{ n: 1 }]);
      })
  );

  test.effect(
    "composes fresh statement review, skip, and resolution owners in the atomic batch",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, deliver, holdUnboundStage } = yield* documentJourney();
        yield* holdUnboundStage();
        expect((yield* deliver()).status).toBe(202);

        const reviews = yield* owner
          .exec(
            "SELECT id,statement_submission_id FROM ingestion_review_items ORDER BY record_number"
          )
          .pipe(
            Effect.filterOrFail(
              (rows) => rows.length === 2,
              () => "pending" as const
            ),
            Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
          );

        const [first, second] = reviews;

        if (first === undefined || second === undefined) {
          return yield* Effect.die("Expected two ambiguous statement lines");
        }

        const batch = (
          calls: ReadonlyArray<unknown>
        ): Effect.Effect<Awaited<ReturnType<typeof runtime.dispatchFetch>>> =>
          native(() =>
            runtime.dispatchFetch("https://api.fidyapp.com/operations/atomic-batch", {
              method: "POST",
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: "__Host-fidy_session=" + alice.bearer,
                "Fidy-Session-Binding": alice.session,
                "content-type": "application/json",
              },
              body: JSON.stringify({ calls }),
            })
          );

        const edit = {
          callId: batchCallId(1),
          operation: "ingestion.applyReviewEdit",
          input: {
            payload: ReviewWire.SaveDraft({
              id: storedText(first.id),
              revision: 0,
              draft: {
                amount: "42",
                currency: "USD",
                direction: "outflow",
                occurredAt: "",
                counterparty: "local-only",
                userProvidedFields: ["money"],
              },
            }),
          },
        };

        const abandon = {
          callId: batchCallId(2),
          operation: "ingestion.abandonStatementSubmission",
          input: { params: { id: first.statement_submission_id } },
        };

        expect((yield* batch([edit, abandon])).status).toBe(400);
        expect(
          yield* owner.exec(
            "SELECT workspace_revision,draft_json FROM ingestion_review_items WHERE id=?",
            first.id
          )
        ).toEqual([{ workspace_revision: null, draft_json: null }]);
        expect((yield* batch([edit])).status).toBe(200);

        const skip = {
          callId: batchCallId(1),
          operation: "ingestion.skipNeedsReviewItem",
          input: { params: { id: first.id } },
        };

        const resolve = {
          callId: batchCallId(2),
          operation: "ingestion.resolveNeedsReviewItem",
          input: {
            params: { id: second.id },
            payload: {
              extraction: {
                money: { amount: "8.50", currency: "USD" },
                occurredAt: "2025-11-01T18:00:00.000Z",
                direction: "outflow",
              },
            },
          },
        };

        expect((yield* batch([skip, resolve])).status).toBe(200);
        expect(
          yield* owner.exec(
            "SELECT workspace_state,workspace_revision FROM ingestion_review_items ORDER BY record_number"
          )
        ).toEqual([
          { workspace_state: "skipped", workspace_revision: 2 },
          { workspace_state: "created", workspace_revision: 1 },
        ]);
        expect(yield* owner.exec("SELECT count(*) AS n FROM source_attestations")).toEqual([
          { n: 1 },
        ]);
        expect(yield* owner.exec("SELECT clarification_state FROM statement_submissions")).toEqual([
          { clarification_state: "completed" },
        ]);
      })
  );
  test.effect(
    "refuses unsupported file signatures without holding the Free backfill or staging bytes",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, deliver } = yield* documentJourney("media_statement_pdf");
        expect((yield* deliver()).status).toBe(422);
        expect((yield* deliver()).status).toBe(422);
        expect(yield* owner.exec("SELECT submission_id FROM statement_backfill")).toEqual([]);
        expect(yield* owner.exec("SELECT id FROM statement_submissions")).toEqual([]);
        const bucket = yield* native(() => runtime.getR2Bucket("STATEMENT_STAGING_BUCKET", "core"));
        expect((yield* native(() => bucket.list())).objects).toHaveLength(0);
      })
  );
});
