import { Clock, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { afterAll, expect, it } from "vitest";
import { isolatedTestStorage } from "../d1-test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { processForwardedEmail } from "./operations";
import { sweepMediaSubmissions, sweepReviewDrafts } from "./runtime";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const io = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const id = (ordinal: number): string =>
  `14590000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const receiptColumns =
  "rowid,id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms,time_zone,deferred_checked_at_ms,outcome,outcome_transaction_id,outcome_review_id,outcome_completed_at_ms,dispatch_sent_at_ms";
const mediaColumns =
  "rowid,id,user_id,portfolio_id,bsuid,message_id,input_digest,media_id,caption,accepted_at_ms,expires_at_ms,service_market,locale,time_zone,capacity_held";
const body = new TextEncoder().encode(
  `From: bank@example.test\r\nTo: other@example.test\r\nSubject: Compra\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<!doctype html><html><body><p>DAVIbank te notifica que realizaste con tu tarjeta Visa Oro la siguiente transacción o compra recurrente:</p><table><tr><td>Comercio</td><td>COMERCIO FICTICIO</td></tr><tr><td>Monto</td><td>12,500</td></tr><tr><td>Fecha</td><td>2026/01/15</td></tr><tr><td>Hora</td><td>12:34:56</td></tr></table></body></html>`
);

it.each(["valid", "orphan-overlay", "interrupted-copy", "interrupted-swap"] as const)(
  "preserves review ownership, email replay and independent expiry or rolls back %s conversion",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* io(() => storage.acquire());
        const current = schemaStatements(
          yield* io(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({
          current,
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* io(() =>
              Bun.file(
                new URL("./email-media-review-cutover.test-fixture.json", import.meta.url)
              ).text()
            )
          ),
        });
        yield* io(() => db.batch(previous.map((sql) => db.prepare(sql))));
        const at = yield* Clock.currentTimeMillis;
        const expires = at + 2592000000;
        const digest = Hex.encode(
          new Uint8Array(yield* io(() => crypto.subtle.digest("SHA-256", body)))
        );
        yield* io(() =>
          db.batch([
            ...[1, 2].flatMap((ordinal) => [
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
                )
                .bind(id(ordinal)),
              db
                .prepare(
                  "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES('processing_grant',?, ?,'{}','fixture','fixture',1,1)"
                )
                .bind(id(ordinal + 20), id(ordinal)),
            ]),
            ...[3, 4, 5].map((ordinal) =>
              db
                .prepare(
                  "INSERT INTO forwarded_email_receipts(rowid,id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms,time_zone) VALUES(?,?,?,?,?,?,'queued',?,?,'America/Bogota')"
                )
                .bind(
                  ordinal + 30,
                  id(ordinal),
                  id(ordinal === 4 ? 2 : 1),
                  ordinal === 5 ? digest : String(ordinal).repeat(64),
                  `email/v1/${id(ordinal)}`,
                  body.byteLength,
                  at - 1000,
                  expires
                )
            ),
            ...[3, 4].map((ordinal) =>
              db
                .prepare(
                  "UPDATE forwarded_email_receipts SET review_id=?,review_reason='unsupported-content',review_created_at_ms=?,review_evidence_expires_at_ms=? WHERE id=?"
                )
                .bind(id(ordinal + 5), at, expires, id(ordinal))
            ),
            ...[3, 4].map((ordinal) =>
              db
                .prepare(
                  "UPDATE forwarded_email_receipts SET outcome='needs-review',outcome_review_id=?,outcome_completed_at_ms=? WHERE id=?"
                )
                .bind(id(ordinal + 5), at, id(ordinal))
            ),
            db
              .prepare(
                "UPDATE forwarded_email_receipts SET dispatch_user_id=user_id,dispatch_sent_at_ms=? WHERE id=?"
              )
              .bind(at, id(3)),
            db
              .prepare("UPDATE forwarded_email_receipts SET dispatch_user_id=user_id WHERE id=?")
              .bind(id(4)),
            ...[6, 7].map((ordinal) =>
              db
                .prepare(
                  "INSERT INTO media_submissions(rowid,id,user_id,portfolio_id,bsuid,message_id,input_digest,media_id,caption,accepted_at_ms,expires_at_ms,service_market,locale,time_zone,review_reason,review_created_at_ms) VALUES(?,?,?,'fixture','CO.fixture',?,?,'private','Personal caption',?,?,'CO','es-CO','America/Bogota','extraction-unavailable',?)"
                )
                .bind(
                  ordinal + 40,
                  id(ordinal),
                  id(ordinal - 5),
                  id(ordinal),
                  "a".repeat(64),
                  at,
                  expires,
                  at
                )
            ),
            db
              .prepare(
                "INSERT INTO ingestion_review_state(rowid,id,user_id,status,revision,draft_json,expires_at_ms,updated_at_ms,created_at_ms) VALUES(91,?,?,'skipped',3,'{\"notes\":\"email draft\"}',?,?,?)"
              )
              .bind(id(8), id(1), expires, at + 1, at),
            db
              .prepare(
                "INSERT INTO ingestion_review_state(rowid,id,user_id,status,revision,draft_json,expires_at_ms,updated_at_ms,created_at_ms) VALUES(92,?,?,'pending',2,'{\"notes\":\"media draft\"}',?,?,?)"
              )
              .bind(id(7), id(2), expires, at + 2, at),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('past','removed',1,'Complete')"
            ),
            db.prepare(
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','forwarded_email_receipts','initial:33','{\"oldReceipt\":true}',1)"
            ),
          ])
        );
        const process = (): Promise<void> =>
          processForwardedEmail({
            DB: db,
            userId: id(1),
            receiptId: id(5),
            EMAIL_BUCKET: {
              get: () =>
                Promise.resolve(
                  Option.some({
                    size: body.byteLength,
                    arrayBuffer: () => Promise.resolve(body.buffer),
                  })
                ),
            },
          });
        yield* io(process);
        expect(
          yield* io(() =>
            db
              .prepare("SELECT outcome FROM forwarded_email_receipts WHERE id=?")
              .bind(id(5))
              .first()
          )
        ).toEqual({ outcome: "accepted" });
        if (history === "orphan-overlay") {
          yield* io(() =>
            db
              .prepare(
                "INSERT INTO ingestion_review_state(id,user_id,status,revision,expires_at_ms,updated_at_ms,created_at_ms) VALUES(?,?,'pending',1,?,?,?)"
              )
              .bind(id(99), id(1), expires, at, at)
              .run()
          );
        }
        const retained = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name"),
            ...[
              "users",
              "forwarded_email_receipts",
              "media_submissions",
              "ingestion_review_items",
              "ingestion_review_state",
              "transactions",
              "source_attestations",
              "erasure_archives",
            ].map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)),
          ]);
        const before = (yield* io(retained)).map((result) => result.results);
        const stable = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare(`SELECT ${receiptColumns} FROM forwarded_email_receipts ORDER BY rowid`),
            db.prepare(`SELECT ${mediaColumns} FROM media_submissions ORDER BY rowid`),
            ...["users", "transactions", "source_attestations", "erasure_archives"].map((table) =>
              db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)
            ),
          ]);
        const exact = (yield* io(stable)).map((result) => result.results);
        const objects = yield* io(() =>
          db
            .prepare(
              "SELECT type,name FROM sqlite_schema WHERE type IN('view','trigger','index') AND sql IS NOT NULL"
            )
            .all<{ type: string; name: string }>()
        );
        const guide = yield* io(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const apply = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(
            [
              "PRAGMA defer_foreign_keys=ON",
              ...documentedSqlBlock({ guide, marker: "email-media-review-preflight" }),
              ...objects.results
                .filter((object) => object.type !== "index")
                .map((object) => `DROP ${object.type.toUpperCase()} "${object.name}"`),
              schemaDefinition({ source: current, target: "forwarded_email_receipts" }).replace(
                "CREATE TABLE forwarded_email_receipts (",
                "CREATE TABLE forwarded_email_receipts_1459 ("
              ),
              ...documentedSqlBlock({ guide, marker: "email-media-review-copy" }),
              ...documentedSqlBlock({ guide, marker: "email-media-review-copy-check" }),
              ...(history === "interrupted-copy"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...objects.results
                .filter((object) => object.type === "index")
                .map((object) => `DROP INDEX "${object.name}"`),
              ...documentedSqlBlock({ guide, marker: "email-media-review-swap" }),
              ...(history === "interrupted-swap"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...current.filter((sql) => /^CREATE (?:UNIQUE )?(?:INDEX|VIEW|TRIGGER) /u.test(sql)),
              ...documentedSqlBlock({ guide, marker: "email-media-review-verify" }),
            ].map((sql) => db.prepare(sql))
          );
        if (history !== "valid") {
          yield* io(() => expect(apply()).rejects.toThrow("CHECK constraint failed: accepted = 1"));
          expect((yield* io(retained)).map((result) => result.results)).toEqual(before);
          return;
        }
        yield* io(apply);
        expect((yield* io(stable)).map((result) => result.results)).toEqual(exact);
        expect(
          (yield* io(() =>
            db
              .prepare(
                "SELECT id,user_id,source_kind,reason,created_at_ms,evidence_expires_at_ms,workspace_state,workspace_revision,workspace_archive_row_ref FROM ingestion_review_items ORDER BY id"
              )
              .all()
          )).results
        ).toEqual([
          ...[6, 7].map((ordinal) => ({
            id: id(ordinal),
            user_id: id(ordinal - 5),
            source_kind: "media",
            reason: "extraction-unavailable",
            created_at_ms: at,
            evidence_expires_at_ms: expires,
            workspace_state: ordinal === 7 ? "pending" : null,
            workspace_revision: ordinal === 7 ? 2 : null,
            workspace_archive_row_ref: ordinal === 7 ? "92" : null,
          })),
          ...[8, 9].map((ordinal) => ({
            id: id(ordinal),
            user_id: id(ordinal - 7),
            source_kind: "email",
            reason: "unsupported-content",
            created_at_ms: at,
            evidence_expires_at_ms: expires,
            workspace_state: ordinal === 8 ? "skipped" : null,
            workspace_revision: ordinal === 8 ? 3 : null,
            workspace_archive_row_ref: ordinal === 8 ? "91" : null,
          })),
        ]);
        expect(
          (yield* io(() =>
            db
              .prepare(
                "SELECT dispatch_pending,dispatch_sent_at_ms FROM forwarded_email_receipts ORDER BY id"
              )
              .all()
          )).results
        ).toEqual([
          { dispatch_pending: 1, dispatch_sent_at_ms: at },
          { dispatch_pending: 1, dispatch_sent_at_ms: null },
          { dispatch_pending: 0, dispatch_sent_at_ms: null },
        ]);
        yield* io(process);
        expect(
          yield* io(() => db.prepare("SELECT count(*) AS total FROM transactions").first())
        ).toEqual({ total: 1 });
        yield* sweepReviewDrafts({ db, current: expires + 1 });
        yield* sweepMediaSubmissions({ db, now: expires + 1 });
        expect(
          (yield* io(() =>
            db
              .prepare(
                "SELECT workspace_state,workspace_revision,draft_json,evidence_expires_at_ms FROM ingestion_review_items WHERE id=?"
              )
              .bind(id(8))
              .all()
          )).results
        ).toEqual([
          {
            workspace_state: "skipped",
            workspace_revision: 3,
            draft_json: null,
            evidence_expires_at_ms: expires,
          },
        ]);
        expect(
          (yield* io(() =>
            db
              .prepare("SELECT capacity_held,media_id,caption FROM media_submissions ORDER BY id")
              .all()
          )).results
        ).toEqual([
          { capacity_held: 0, media_id: null, caption: null },
          { capacity_held: 0, media_id: null, caption: null },
        ]);
        expect((yield* io(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
      })
    )
);
