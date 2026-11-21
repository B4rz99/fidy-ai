import deliveryWorker from "./email-worker";
import { admitPurge, caseDriver } from "../erasure-purge.test-fixture";
import type { Miniflare } from "miniflare";
import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import {
  Array as Arr,
  Data,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import { expect } from "vitest";
import { allowancePeriod } from "../../src/core/quotas/operations";
import { freeForwardedEmailCap } from "../../src/core/ingestion/contract";
import {
  type EmailCapacityCommand,
  directoryName,
  emailCapacityUrl,
  outstandingEmailLimit,
  retainedEmailLimit,
} from "../directory/contract";
import { alice, bob, seed } from "../financial-user-store.test-fixture";
import { native, nativeBillingPlatform, nativePurgePlatform } from "../user-store.test-fixture";

const CapacityCommandWire = Data.taggedEnum<typeof EmailCapacityCommand.Encoded>();

const decodeCapacityClaim = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    expires_at_ms: Schema.Int,
    capacity_slot: Schema.Int,
    capacity_generation: Schema.Int,
  })
);

const storedText = Schema.decodeUnknownSync(Schema.String);

const emailRecipient = Effect.fn(function* (runtime: Miniflare, subject: typeof alice) {
  const owner = yield* seed(runtime, subject, false);
  yield* owner.exec(
    "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('grant',?,'processing_grant',?)",
    subject.user,
    owner.now
  );

  const headers = {
    origin: "https://app.fidyapp.com",
    cookie: "__Host-fidy_session=" + subject.bearer,
    "Fidy-Session-Binding": subject.session,
  };

  const get = yield* native(() =>
    runtime.dispatchFetch("https://api.fidyapp.com/ingestion/email-forwarding", { headers })
  );

  const address = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      data: Schema.Struct({ address: Schema.Struct({ address: Schema.String }) }),
    })
  )(yield* native(() => get.json()));

  const { PRIVATE_EMAIL: worker } = yield* native(() =>
    runtime.getBindings<{ PRIVATE_EMAIL: Pick<Fetcher, "fetch"> }>("core")
  );

  const mime =
    "From: sender@example.com\r\nTo: " +
    address.data.address.address +
    "\r\nSubject: aviso\r\n\r\nPrivate unknown format";

  const send = (
    publicDelivery: boolean,
    material = mime
  ): Effect.Effect<Awaited<ReturnType<typeof worker.fetch>>> =>
    native(() =>
      worker.fetch("https://fixture.invalid/" + (publicDelivery ? "production" : "eligible"), {
        method: "POST",
        headers: { "fidy-fixture-to": address.data.address.address },
        body: material,
      })
    );

  return { runtime, owner, send, mime };
});

const emailJourney = Effect.fn(function* () {
  return yield* emailRecipient(yield* (yield* nativeBillingPlatform)(), alice);
});

const fixtureControl = Effect.fn(function* (
  user: ReturnType<Awaited<ReturnType<Miniflare["getDurableObjectNamespace"]>>["getByName"]>,
  path: string
) {
  return yield* native(() => user.fetch("https://fixture.invalid/" + path, { method: "POST" }));
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "uses only native Email Routing events on the Email Worker while User alarms own retained work",
    () =>
      Effect.sync(() => {
        expect(Object.keys(deliveryWorker)).toEqual(["email"]);
      })
  );
  test.effect(
    "erasure waits for an issued R2 create, releases the claimed Directory slot and clears native KV and alarm",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativePurgePlatform)();
        const journey = yield* emailRecipient(runtime, alice);

        const user = (yield* native(() =>
          runtime.getDurableObjectNamespace("USER_STORE", "core")
        )).getByName(alice.user);

        const cases = yield* caseDriver(runtime);
        yield* fixtureControl(user, "hold-original");
        const sending = yield* journey.send(false).pipe(Effect.forkScoped);

        const [writer] = yield* journey.owner
          .exec("SELECT nonce,object_key FROM original_writers")
          .pipe(
            Effect.repeat({
              until: (rows) => rows.length === 1,
              times: 60,
              schedule: Schedule.spaced("30 millis"),
            })
          );

        const key = yield* Schema.decodeUnknownEffect(Schema.String)(writer?.object_key);
        const bucket = yield* native(() => runtime.getR2Bucket("EMAIL_BUCKET", "core"));
        expect(yield* native(() => bucket.head(key))).toBeNull();
        expect((yield* admitPurge(runtime)).status).toBe(202);

        yield* Effect.forEach(
          Arr.range(1, 4),
          Effect.fnUntraced(function* () {
            expect(yield* cases.step()).toBe("Draining");
          }),
          { discard: true }
        );
        yield* fixtureControl(user, "release-original");
        const sent = yield* Fiber.await(sending);
        expect(Exit.isFailure(sent) || sent.value.status !== 204).toBe(true);

        const phase = yield* cases
          .step()
          .pipe(Effect.repeat({ until: (value) => value === "ExternalPending", times: 12 }));

        expect(phase).toBe("ExternalPending");
        expect(yield* native(() => bucket.head(key))).toBeNull();
        expect(
          yield* native(() =>
            journey.owner.directory.exec(
              "SELECT receipt FROM email_capacity_slots WHERE receipt IS NOT NULL"
            )
          )
        ).toEqual([]);
        const physical = yield* fixtureControl(user, "storage");
        expect(yield* native(() => physical.json())).toEqual({ keys: 0, alarm: null });
      })
  );
  test.effect(
    "observing an exact R2 nonce settles a lost original reply before its placeholder is replaced",
    () =>
      Effect.gen(function* () {
        const { owner, send } = yield* emailJourney();
        yield* owner.exec(
          "CREATE TRIGGER lose_original_reply BEFORE DELETE ON original_writers BEGIN SELECT RAISE(ABORT,'fixture'); END"
        );
        expect((yield* Effect.exit(send(false)))._tag).toBe("Failure");
        expect((yield* owner.exec("SELECT nonce FROM original_writers")).length).toBe(1);
        yield* owner.exec("DROP TRIGGER lose_original_reply");
        expect((yield* send(false)).status).toBe(204);
        expect(yield* owner.exec("SELECT nonce FROM original_writers")).toEqual([]);
      })
  );
  test.effect(
    "private eligible Email stages exactly once, enforces its original 90-day deadline and refuses delayed work",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, send, mime } = yield* emailJourney();
        expect((yield* send(true)).status).toBe(422);
        expect(yield* owner.exec("SELECT id FROM forwarded_email_receipts")).toEqual([]);
        expect((yield* send(false)).status).toBe(204);
        expect((yield* send(false)).status).toBe(204);

        const rows = yield* owner
          .exec(
            "SELECT id,object_key,expires_at_ms-received_at_ms AS retained,outcome FROM forwarded_email_receipts"
          )
          .pipe(
            Effect.filterOrFail(
              (rows) => rows[0]?.outcome === "needs-review",
              () => "waiting" as const
            ),
            Effect.retry({ times: 60, schedule: Schedule.spaced("50 millis") })
          );

        expect(rows).toHaveLength(1);
        expect(rows[0]?.retained).toBe(7776000000);
        const bucket = yield* native(() => runtime.getR2Bucket("EMAIL_BUCKET", "core"));
        const object = yield* native(() => bucket.get(storedText(rows[0]?.object_key)));

        if (object === null) return yield* Effect.die("Expected private email");
        expect(yield* native(() => object.text())).toBe(mime);

        const own = yield* owner.exec(
          "SELECT id,evidence_expires_at_ms FROM ingestion_review_items"
        );

        expect(own).toHaveLength(1);
        yield* owner.exec(
          "UPDATE forwarded_email_receipts SET received_at_ms=0,expires_at_ms=7776000000,outcome=NULL"
        );
        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
        expect(
          (yield* native(() =>
            users.getByName(alice.user).fetch("https://coordinator.internal/forwarded-email-work", {
              method: "POST",
              body: JSON.stringify({ receiptId: rows[0]?.id, userId: alice.user }),
            })
          )).ok
        ).toBe(true);
        expect((yield* send(false)).status).toBe(422);
        expect(
          yield* owner.exec("SELECT outcome,expires_at_ms FROM forwarded_email_receipts")
        ).toEqual([{ outcome: null, expires_at_ms: 7776000000 }]);
      })
  );
  test.effect(
    "reclaims the final fleet Email slot without admitting concurrent or stale claims",
    () =>
      Effect.gen(function* () {
        const first = yield* emailJourney();
        const second = yield* emailRecipient(first.runtime, bob);
        const directory = first.owner.directory;
        const expiry = first.owner.now + 86400000;
        yield* native(() =>
          directory.exec(
            "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO email_capacity_slots SELECT i,1,'fixture-'||i,?,CASE WHEN i<? THEN 'outstanding' ELSE 'retained' END FROM n",
            retainedEmailLimit - 1,
            expiry,
            outstandingEmailLimit
          )
        );

        yield* Effect.forEach(
          [first, second],
          Effect.fnUntraced(function* (recipient) {
            yield* recipient.owner.exec(
              "CREATE TRIGGER stop_claim_ack BEFORE UPDATE OF capacity_claimed ON forwarded_email_receipts WHEN NEW.capacity_claimed=1 BEGIN SELECT RAISE(ABORT,'fixture'); END"
            );
          }),
          { discard: true }
        );

        const attempts = yield* Effect.all(
          [Effect.exit(first.send(false)), Effect.exit(second.send(false))],
          { concurrency: 2 }
        );

        expect(attempts.filter((item) => Exit.isFailure(item))).toHaveLength(1);
        const admitted = Exit.isFailure(attempts[0]) ? first : second;
        const refused = admitted === first ? second : first;
        const refusal = attempts.find((item) => Exit.isSuccess(item));
        expect(Predicate.isTagged(refusal, "Success") && refusal.value.status).toBe(422);

        const [claim] = yield* admitted.owner.exec(
          "SELECT id,expires_at_ms,capacity_slot,capacity_generation,capacity_claimed FROM forwarded_email_receipts WHERE state='storing'"
        );

        expect(claim).toMatchObject({ capacity_slot: retainedEmailLimit, capacity_claimed: 0 });
        expect(
          yield* native(() =>
            directory.exec(
              "SELECT count(*) AS n FROM email_capacity_slots WHERE state='outstanding'"
            )
          )
        ).toEqual([{ n: outstandingEmailLimit }]);

        yield* Effect.forEach(
          [first, second],
          Effect.fnUntraced(function* (recipient) {
            yield* recipient.owner.exec("DROP TRIGGER stop_claim_ack");
          }),
          { discard: true }
        );

        expect((yield* admitted.send(false)).status).toBe(204);

        const ready = yield* admitted.owner
          .exec("SELECT capacity_settled,outcome FROM forwarded_email_receipts")
          .pipe(
            Effect.filterOrFail(
              (rows) => rows[0]?.capacity_settled === 1,
              () => "unsettled" as const
            ),
            Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
          );

        expect(ready).toEqual([{ capacity_settled: 1, outcome: "needs-review" }]);
        expect((yield* refused.send(false, refused.mime + "new")).status).toBe(422);
        yield* native(() =>
          directory.exec(
            "UPDATE email_capacity_slots SET expires_at_ms=0 WHERE slot=?",
            outstandingEmailLimit + 1
          )
        );
        yield* native(() =>
          directory.exec(
            "UPDATE email_capacity_slots SET state='outstanding' WHERE slot=?",
            outstandingEmailLimit
          )
        );
        expect((yield* refused.send(false, refused.mime + "outstanding-full")).status).toBe(422);
        yield* native(() =>
          directory.exec(
            "UPDATE email_capacity_slots SET state='retained' WHERE slot=?",
            outstandingEmailLimit
          )
        );
        expect((yield* refused.send(false, refused.mime + "next")).status).toBe(204);

        const ns = yield* native(() =>
          first.runtime.getDurableObjectNamespace("DIRECTORY", "core")
        );

        const target = decodeCapacityClaim(claim);

        const mutate = (
          action: "Claim" | "Release"
        ): Effect.Effect<Awaited<ReturnType<ReturnType<typeof ns.getByName>["fetch"]>>> =>
          native(() =>
            ns.getByName(directoryName).fetch(emailCapacityUrl, {
              method: "POST",
              body: JSON.stringify(
                CapacityCommandWire[action]({
                  slot: target.capacity_slot,
                  generation: target.capacity_generation,
                  receipt: target.id,
                  expires: target.expires_at_ms,
                })
              ),
            })
          );

        expect((yield* mutate("Release")).status).toBe(204);
        expect((yield* mutate("Release")).status).toBe(204);
        expect((yield* mutate("Claim")).status).toBe(409);
        expect(
          yield* native(() =>
            directory.exec(
              "SELECT slot FROM email_capacity_slots WHERE receipt=?",
              storedText(claim?.id)
            )
          )
        ).toEqual([]);
      })
  );
  test.effect(
    "resumes the exact deferred and dispatched Email after withdrawal while rejecting fresh material",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, send, mime } = yield* emailJourney();

        const period = DateTime.toEpochMillis(
          allowancePeriod(DateTime.makeUnsafe(owner.now)).startsAt
        );

        yield* owner.exec(
          "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO commercial_allowance_consumptions SELECT ?,'forwarded_email','fixture-'||i,?,?,1 FROM n",
          freeForwardedEmailCap,
          alice.user,
          period,
          owner.now
        );
        expect((yield* send(false)).status).toBe(204);

        const [deferred] = yield* owner.exec(
          "SELECT id,expires_at_ms FROM forwarded_email_receipts WHERE deferred_checked_at_ms IS NOT NULL AND outcome IS NULL"
        );

        expect(deferred).toBeDefined();
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,record_type,grant_record_id,session_id,occurred_at_ms) VALUES('withdraw',?,'processing_withdrawal','grant',?,?)",
          alice.user,
          alice.session,
          owner.now
        );
        expect((yield* send(false, mime + "new")).status).toBe(422);
        yield* owner.exec(
          "DELETE FROM commercial_allowance_consumptions WHERE identity LIKE 'fixture-%'"
        );
        yield* owner.exec("UPDATE forwarded_email_receipts SET deferred_checked_at_ms=0");
        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
        expect(
          (yield* native(() =>
            users
              .getByName(alice.user)
              .fetch("https://owner.internal/work/check", { method: "POST" })
          )).status
        ).toBe(204);

        const settled = yield* owner
          .exec(
            "SELECT id,expires_at_ms FROM forwarded_email_receipts WHERE dispatch_sent_at_ms IS NOT NULL AND outcome='needs-review'"
          )
          .pipe(
            Effect.filterOrFail(
              (rows) => rows.length === 1,
              () => "Unsettled Email" as const
            ),
            Effect.retry({ times: 60, schedule: Schedule.spaced("50 millis") })
          );

        expect(settled).toEqual([deferred]);
        expect(yield* owner.exec("SELECT email_receipt_id FROM ingestion_review_items")).toEqual([
          { email_receipt_id: deferred?.id },
        ]);
        expect(
          yield* owner.exec(
            "SELECT identity,units FROM commercial_allowance_consumptions WHERE allowance='forwarded_email'"
          )
        ).toEqual([{ identity: deferred?.id, units: 1 }]);
      })
  );
  test.effect("discards unadmitted Email bytes when Consent is withdrawn during staging", () =>
    Effect.gen(function* () {
      const { runtime, owner, send } = yield* emailJourney();
      yield* owner.exec(
        "CREATE TRIGGER stop_activation BEFORE UPDATE OF state ON forwarded_email_receipts WHEN NEW.state='queued' BEGIN SELECT RAISE(ABORT,'fixture'); END"
      );
      expect((yield* Effect.exit(send(false)))._tag).toBe("Failure");

      const [stage] = yield* owner.exec(
        "SELECT object_key FROM forwarded_email_receipts WHERE state='storing'"
      );

      const bucket = yield* native(() => runtime.getR2Bucket("EMAIL_BUCKET", "core"));
      const key = storedText(stage?.object_key);
      expect(yield* native(() => bucket.head(key))).not.toBeNull();
      yield* owner.exec("DROP TRIGGER stop_activation");
      yield* owner.exec(
        "INSERT INTO consent_history(id,user_id,record_type,grant_record_id,session_id,occurred_at_ms) VALUES('withdraw',?,'processing_withdrawal','grant',?,?)",
        alice.user,
        alice.session,
        owner.now
      );
      yield* owner.exec("UPDATE forwarded_email_receipts SET stage_checked_at_ms=0");
      const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
      expect(
        (yield* native(() =>
          users.getByName(alice.user).fetch("https://owner.internal/work/check", { method: "POST" })
        )).status
      ).toBe(204);
      yield* native(() => bucket.head(key)).pipe(
        Effect.filterOrFail(
          (head) => head === null,
          () => "Unadmitted Email retained" as const
        ),
        Effect.retry({ times: 60, schedule: Schedule.spaced("50 millis") })
      );
      expect(yield* owner.exec("SELECT id FROM ingestion_review_items")).toEqual([]);
      expect(yield* owner.exec("SELECT id FROM transactions")).toEqual([]);
      expect(yield* owner.exec("SELECT id FROM forwarded_email_receipts")).toEqual([]);
    })
  );
  test.effect(
    "records one deterministic Email capture and unapproved structural candidate, then erases the original and candidate",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, send } = yield* emailJourney();

        const material =
          "From: bank@example.test\r\nTo: mailbox@example.test\r\nSubject: Compra\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" +
          `<!doctype html><html><body>
      <p>DAVIbank te notifica que realizaste con tu tarjeta Visa Oro la siguiente transacción o compra recurrente:</p>
      <table><tr><td>Comercio</td><td>COMERCIO FICTICIO</td></tr><tr><td>Monto</td><td>12,500</td></tr><tr><td>Fecha</td><td>2026/01/15</td></tr><tr><td>Hora</td><td>10:15:30</td></tr></table></body></html>`;

        yield* owner.exec("UPDATE users SET time_zone='America/Lima' WHERE id=?", alice.user);
        yield* owner.exec(
          "CREATE TRIGGER stop_activation BEFORE UPDATE OF state ON forwarded_email_receipts WHEN NEW.state='queued' BEGIN SELECT RAISE(ABORT,'fixture'); END"
        );
        expect((yield* Effect.exit(send(false, material)))._tag).toBe("Failure");

        const [staged] = yield* owner.exec(
          "SELECT expires_at_ms,state,object_key FROM forwarded_email_receipts"
        );

        expect(staged?.state).toBe("storing");
        yield* owner.exec("DROP TRIGGER stop_activation");
        yield* owner.exec("UPDATE forwarded_email_receipts SET stage_checked_at_ms=0");

        const usersBefore = yield* native(() =>
          runtime.getDurableObjectNamespace("USER_STORE", "core")
        );

        expect(
          (yield* native(() =>
            usersBefore
              .getByName(alice.user)
              .fetch("https://owner.internal/work/check", { method: "POST" })
          )).status
        ).toBe(204);

        const rows = yield* owner
          .exec(
            "SELECT r.id,r.object_key,r.expires_at_ms,c.structure,c.expires_at_ms AS candidate_expiry,c.revision FROM forwarded_email_receipts r JOIN ingest_sample_candidates c ON c.receipt_id=r.id"
          )
          .pipe(
            Effect.filterOrFail(
              (rows) => rows.length === 1,
              () => "pending" as const
            ),
            Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
          );

        const [row] = rows;

        if (row === undefined) return yield* Effect.die("Expected candidate");
        expect(row.candidate_expiry).toBe(row.expires_at_ms);
        expect(row.expires_at_ms).toBe(staged?.expires_at_ms);
        expect(row.revision).toBe(1);
        expect(storedText(row.structure)).not.toMatch(/FICTICIO|12500|example/u);
        expect(
          yield* owner.exec(
            "SELECT kind,time_zone,received_email_id FROM source_attestations WHERE user_id=?",
            alice.user
          )
        ).toEqual([
          { kind: "notification-email", time_zone: "America/Lima", received_email_id: row.id },
        ]);
        expect(
          yield* owner.exec("SELECT amount FROM transactions WHERE user_id=?", alice.user)
        ).toEqual([{ amount: "12500" }]);
        expect((yield* send(false, material)).status).toBe(204);
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,record_type,grant_record_id,session_id,occurred_at_ms) VALUES('withdraw',?,'processing_withdrawal','grant',?,?)",
          alice.user,
          alice.session,
          owner.now
        );
        expect((yield* send(false, material + "new")).status).toBe(422);
        yield* owner.exec(
          "UPDATE forwarded_email_receipts SET received_at_ms=0,expires_at_ms=7776000000"
        );
        yield* owner.exec("UPDATE ingest_sample_candidates SET expires_at_ms=7776000000");
        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

        const check = yield* native(() =>
          users.getByName(alice.user).fetch("https://owner.internal/work/check", { method: "POST" })
        );

        expect(check.status).toBe(204);
        yield* owner.exec("SELECT state FROM forwarded_email_receipts").pipe(
          Effect.filterOrFail(
            (rows) => rows[0]?.state === "expired",
            () => "pending" as const
          ),
          Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
        );
        const bucket = yield* native(() => runtime.getR2Bucket("EMAIL_BUCKET", "core"));
        expect(yield* native(() => bucket.head(storedText(row.object_key)))).toBeNull();
        expect(yield* owner.exec("SELECT id FROM ingest_sample_candidates")).toEqual([]);
        expect(yield* owner.exec("SELECT count(*) AS n FROM transactions")).toEqual([{ n: 1 }]);
      })
  );
});
