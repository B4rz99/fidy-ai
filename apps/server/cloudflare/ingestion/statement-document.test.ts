import { type HostedCanonicalCaller } from "../canonical-work/contract";
import { type OutboundHttpService } from "../../src/shell/outbound-http/operations";
import { Clock, Data, DateTime, Effect, Exit, Option } from "effect";
import { deepStrictEqual } from "node:assert";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import { recoverHeldStatementDocument } from "./operations";
import { WhatsAppBusinessPhoneNumberId } from "../../src/shell/channels/whatsapp/contract";
import { StatementDocumentUnavailable } from "./contract";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
class TestFailure extends Data.TaggedError("TestFailure")<{ cause: unknown }> {}
const wait = <A>(run: () => Promise<A>): Effect.Effect<A, TestFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TestFailure({ cause }) });

const heldDocument = (): Effect.Effect<
  Parameters<typeof recoverHeldStatementDocument>[0],
  TestFailure
> =>
  Effect.gen(function* () {
    const { db, bucket } = yield* wait(storage.acquire);
    yield* wait(() => installTestSchema({ db }));
    const current = yield* Clock.currentTimeMillis;
    const caller: HostedCanonicalCaller = {
      _tag: "HostedCanonical",
      userId: "10000000-0000-4000-8000-000000000001",
      sessionId: "session",
      turnId: "turn",
      authorizedOperation: Option.none(),
      originTurns: { sql: "SELECT 'turn' AS turn_id", params: [] },
      publicationOrigin: { sql: "SELECT 'turn' AS turn_id", params: [] },
      authority: {
        table: "hosted_turns",
        predicate: "id = ? AND status = 'pending'",
        bindings: ["turn"],
      },
    };
    yield* wait(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(caller.userId, current),
        db
          .prepare(
            "INSERT INTO consent_history (record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES ('processing_grant','consent',?,'{}','disclosure','decision',1,1)"
          )
          .bind(caller.userId),
        db
          .prepare(
            "INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,status) VALUES ('session',?,'{}',?,'active')"
          )
          .bind(caller.userId, current),
        db
          .prepare(
            "INSERT INTO hosted_turns(id,user_id,hosted_session_id,started_at_ms,status) VALUES ('turn',?,'session',?,'pending')"
          )
          .bind(caller.userId, current),
        db
          .prepare(
            "WITH incoming(turn_id,user_id,media_id,created_at_ms) AS (VALUES ('turn',?,'media',?)) UPDATE hosted_turns SET document_media_id=incoming.media_id,document_created_at_ms=incoming.created_at_ms FROM incoming WHERE hosted_turns.id=incoming.turn_id AND hosted_turns.user_id=incoming.user_id"
          )
          .bind(caller.userId, current),
      ])
    );
    const bytes = new TextEncoder().encode("Fecha,Descripcion,Valor\n2026-01-01,Mercado,1000\n");
    const outbound: OutboundHttpService = {
      execute: (request) =>
        Effect.succeed({
          status: 200,
          headers: {},
          body:
            request._tag === "KapsoMediaMetadata"
              ? new TextEncoder().encode(
                  JSON.stringify({
                    id: "media",
                    mime_type: "text/csv",
                    file_size: bytes.length,
                    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
                    download_url:
                      "https://api.kapso.ai/meta/whatsapp/media_download?token=test-token",
                    download_url_expires_at: DateTime.formatIso(
                      DateTime.makeUnsafe(current + 900000)
                    ),
                  })
                )
              : bytes,
        }),
    };
    return {
      db,
      bucket,
      caller,
      current,
      outbound,
      businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
    };
  });

it("refuses a held document at exact supplied Clock lease expiry before retaining bytes and releases its lease", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const work = yield* heldDocument();
      const { db, bucket, current } = work;
      const live = yield* Clock.Clock;
      const expiry = current + 600000;
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => expiry,
        currentTimeMillis: Effect.succeed(expiry),
        currentTimeNanosUnsafe: () => BigInt(expiry) * 1000000n,
        currentTimeNanos: Effect.succeed(BigInt(expiry) * 1000000n),
        monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: live.monotonicTimeNanos,
        sleep: (duration) => live.sleep(duration),
      };
      const result = yield* Effect.exit(
        recoverHeldStatementDocument(work).pipe(Effect.provideService(Clock.Clock, clock))
      );
      deepStrictEqual(result, Exit.fail(new StatementDocumentUnavailable({ reason: "uncertain" })));
      expect((yield* wait(() => bucket.list())).objects).toEqual([]);
      expect(
        yield* wait(() =>
          db
            .prepare(
              "SELECT released_at_epoch_ms FROM resource_admission_events WHERE policy_key='ingestion.upload.outstanding.v1'"
            )
            .first("released_at_epoch_ms")
        )
      ).toBe(expiry);
      expect(
        yield* wait(() =>
          db
            .prepare(
              "SELECT upload_grant_id FROM (SELECT rowid,id AS turn_id,user_id,document_media_id AS media_id,document_staging_id AS staging_id,document_upload_grant_id AS upload_grant_id,document_upload_expires_at_ms AS upload_expires_at_ms,document_reference_json AS reference_json,document_created_at_ms AS created_at_ms FROM hosted_turns WHERE document_media_id IS NOT NULL)"
            )
            .first("upload_grant_id")
        )
      ).toBeNull();
    })
  ));

it("recovers the same staged reference without provider retrieval or another upload charge", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const work = yield* heldDocument();
      const reference = yield* recoverHeldStatementDocument(work);
      const charges = (): Promise<unknown> =>
        work.db.prepare("SELECT count(*) FROM resource_admission_events").first<number>("count(*)");
      const before = yield* wait(charges);
      const recovered = yield* recoverHeldStatementDocument({
        ...work,
        outbound: { execute: () => Effect.die(new Error("Recovery must not retrieve media")) },
      });
      expect(recovered).toEqual(reference);
      expect(yield* wait(charges)).toBe(before);
      expect((yield* wait(() => work.bucket.list())).objects).toHaveLength(1);
      expect(
        yield* wait(() =>
          work.db
            .prepare(
              "SELECT upload_grant_id FROM (SELECT rowid,id AS turn_id,user_id,document_media_id AS media_id,document_staging_id AS staging_id,document_upload_grant_id AS upload_grant_id,document_upload_expires_at_ms AS upload_expires_at_ms,document_reference_json AS reference_json,document_created_at_ms AS created_at_ms FROM hosted_turns WHERE document_media_id IS NOT NULL)"
            )
            .first("upload_grant_id")
        )
      ).toBeNull();
    })
  ));

it("refuses another User's admitted document without provider work, charges or staged bytes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const work = yield* heldDocument();
      const otherUser = "10000000-0000-4000-8000-000000000002";
      yield* wait(() =>
        work.db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(otherUser, work.current)
          .run()
      );
      const result = yield* Effect.exit(
        recoverHeldStatementDocument({
          ...work,
          caller: { ...work.caller, userId: otherUser },
          outbound: {
            execute: () => Effect.die(new Error("Foreign document must not retrieve media")),
          },
        })
      );
      deepStrictEqual(result, Exit.fail(new StatementDocumentUnavailable({ reason: "uncertain" })));
      expect((yield* wait(() => work.bucket.list())).objects).toEqual([]);
      expect(
        yield* wait(() =>
          work.db.prepare("SELECT count(*) FROM resource_admission_events").first("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(() =>
          work.db
            .prepare(
              "SELECT staging_id FROM (SELECT rowid,id AS turn_id,user_id,document_media_id AS media_id,document_staging_id AS staging_id,document_upload_grant_id AS upload_grant_id,document_upload_expires_at_ms AS upload_expires_at_ms,document_reference_json AS reference_json,document_created_at_ms AS created_at_ms FROM hosted_turns WHERE document_media_id IS NOT NULL)"
            )
            .first("staging_id")
        )
      ).toBeNull();
    })
  ));
