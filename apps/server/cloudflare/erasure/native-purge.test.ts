import type { Miniflare } from "miniflare";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { admitPurge, caseDriver } from "../erasure-purge.test-fixture";
import { ErasureOperatorReceipt } from "../../src/core/erasure/contract";
import { erasureRegistryName } from "./contract";
import { ErasureHandoff, localPurgeUrl } from "../erasure-store/contract";
import { expect } from "vitest";
import { alice, bob, history, receivedStatus, seed } from "../financial-user-store.test-fixture";
import { native, nativeBillingPlatform, nativePurgePlatform } from "../user-store.test-fixture";

const anonymousSample =
  '{"serviceMarket":"CO","sourceFormat":"notification-email","sourceProvider":"cloudflare-email","parserRevision":"cloudflare-mime-v1","anonymizationRevision":"structural-tags-v1","structure":{"table":1,"tr":0,"td":0,"p":0,"span":0,"div":0}}';

const repeatPurge = Effect.fn(function* (
  users: Awaited<ReturnType<Miniflare["getDurableObjectNamespace"]>>,
  scope: typeof ErasureHandoff.Type,
  owner: string
) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureHandoff))({
    ...scope,
  });

  return yield* native(() => users.getByName(owner).fetch(localPurgeUrl, { method: "POST", body }));
});

type SeededUser = Effect.Success<ReturnType<typeof seed>>;

const seedDeliveredProof = Effect.fnUntraced(function* (
  owner: SeededUser,
  [work, state, ordinal]: readonly [string, "approved" | "ambiguous", number]
) {
  yield* owner.exec(
    "INSERT INTO browser_handoffs(id,pairing_id,user_id,ordinal,verifier_digest,expires_at_ms,wrong_attempts,minimum_poll_seconds,outcome,state,email_login) VALUES(?,?,?,?, 'synthetic',?,0,1,'committed','pending_approval',1)",
    work,
    work,
    alice.user,
    ordinal,
    owner.now + 60000
  );
  yield* owner.exec(
    "INSERT INTO login_email_proofs(pairing_id,work_id,address,revision,generation,requested_at_ms,expires_at_ms,offer_at_ms,state,selector,delivery_key) VALUES(?,?,'proof@synthetic.test',1,1,?,?,?,?,NULL,?)",
    work,
    work,
    owner.now,
    owner.now + 60000,
    owner.now,
    state,
    work
  );
});

type PhaseHarness = Readonly<{
  runtime: Miniflare;
  driver: Effect.Success<ReturnType<typeof caseDriver>>;
  first: SeededUser;
  users: Awaited<ReturnType<Miniflare["getDurableObjectNamespace"]>>;
  scope: typeof ErasureHandoff.Type;
}>;

const sealingObservation = Effect.fn(function* ({ driver, first, users, scope }: PhaseHarness) {
  expect(yield* first.exec("SELECT state FROM erasure_requests")).toEqual([{ state: "Sealing" }]);
  expect((yield* repeatPurge(users, scope, alice.user)).ok).toBe(false);
  expect(
    yield* native(() => driver.storage.exec("SELECT custodian FROM erasure_case_custodians"))
  ).toEqual([]);
});

const erasingObservation = Effect.fn(function* ({ first }: PhaseHarness) {
  expect(yield* first.exec("SELECT id FROM users")).toEqual([{ id: alice.user }]);
});

const externalObservation = Effect.fn(function* ({ runtime, first, users, scope }: PhaseHarness) {
  expect(yield* first.exec("SELECT name FROM sqlite_schema WHERE name='users'")).toEqual([]);
  yield* native(() => runtime.unsafeEvictDurableObject("core", "UserStore", { name: alice.user }));
  expect(
    (yield* repeatPurge(
      users,
      { ...scope, reference: "22510000-0000-4000-8000-000000000099" },
      alice.user
    )).ok
  ).toBe(false);
  expect((yield* repeatPurge(users, scope, bob.user)).ok).toBe(false);
  expect((yield* repeatPurge(users, scope, alice.user)).status).toBe(204);
});

const phaseObservations = {
  Sealing: sealingObservation,
  Erasing: erasingObservation,
  ExternalPending: externalObservation,
};

const loseThenResumePhase = Effect.fn(function* (
  harness: PhaseHarness,
  state: keyof typeof phaseObservations
) {
  const registry = harness.driver.storage;

  yield* native(() =>
    registry.exec(
      "CREATE TRIGGER lose_phase BEFORE UPDATE OF state ON erasure_cases WHEN NEW.state='" +
        state +
        "' BEGIN SELECT RAISE(ABORT,'lost reply'); END"
    )
  );
  yield* harness.driver.step();
  yield* harness.driver.step();
  expect(
    (yield* native(() => registry.exec("SELECT state FROM erasure_cases")))[0]?.state
  ).not.toBe(state);
  yield* phaseObservations[state](harness);
  yield* native(() => registry.exec("DROP TRIGGER lose_phase"));
  expect(yield* harness.driver.step()).toBe(state);
});

const seedLoginProof = Effect.fn(function* (owner: SeededUser, key: string, ordinal: number) {
  yield* owner.exec(
    "INSERT INTO browser_handoffs(id,pairing_id,user_id,ordinal,verifier_digest,expires_at_ms,wrong_attempts,minimum_poll_seconds,outcome,state,email_login) VALUES(?,?,?,?, 'synthetic',?,0,1,'committed','pending_approval',1)",
    key,
    key,
    alice.user,
    ordinal + 100,
    owner.now + 60000
  );
  yield* owner.exec(
    "INSERT INTO login_email_proofs(pairing_id,work_id,address,revision,generation,requested_at_ms,expires_at_ms,offer_at_ms,state,selector) VALUES(?,?,'proof@synthetic.test',1,1,?,?,?,'awaiting_proof','synthetic-selector')",
    key,
    key,
    owner.now,
    owner.now + 60000,
    owner.now
  );
});

const publishSample = Effect.fn(function* (
  first: SeededUser,
  shared: Awaited<ReturnType<Miniflare["getR2Bucket"]>>,
  [id, artifact]: readonly [string, string]
) {
  const checksum = yield* native(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(artifact))
  );

  yield* native(() =>
    shared.put("samples/" + id, artifact, {
      sha256: checksum,
      customMetadata: { purpose: "anonymous-ingest-sample" },
    })
  );
  yield* first.exec(
    "INSERT INTO ingest_sample_decisions VALUES(?,?,1,?,'issuer','operator',?,?,NULL,'published',NULL)",
    id,
    alice.user,
    new Uint8Array(checksum).toHex(),
    first.now,
    id
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "lost phase acknowledgements resume from the exact independent case after complete storage deletion",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBillingPlatform)();
        const first = yield* seed(runtime, alice);
        yield* seed(runtime, bob);
        const driver = yield* caseDriver(runtime);
        const registry = driver.storage;
        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
        expect((yield* admitPurge(runtime)).status).toBe(202);

        const [record] = yield* native(() =>
          registry.exec(
            "SELECT reference,user_id AS userId,requested_at_ms AS requestedAtMs FROM erasure_cases"
          )
        );

        const scope = yield* Schema.decodeUnknownEffect(ErasureHandoff)(record);

        const harness = { runtime, driver, first, users, scope };

        yield* Effect.forEach(
          ["Sealing", "Erasing", "ExternalPending"] as const,
          (state) => loseThenResumePhase(harness, state),
          { discard: true }
        );

        expect((yield* repeatPurge(users, scope, alice.user)).ok).toBe(false);
        const cases = yield* native(() => runtime.getDurableObjectNamespace("ERASURE", "core"));
        const now = yield* Clock.currentTimeMillis;

        const receipt = yield* native(() =>
          cases
            .getByName(erasureRegistryName)
            .fetch("https://coordinator.internal/erasure-receipt", {
              method: "POST",
              body: JSON.stringify({
                reference: scope.reference,
                userId: scope.userId,
                deadlineMs: now + 4000,
                authority: {
                  permission: "titular.erase",
                  operatorRef: "fixture",
                  expiresAtMs: now + 60000,
                },
              }),
            })
        );

        const evidence = yield* Schema.decodeUnknownEffect(ErasureOperatorReceipt)(
          yield* native(() => receipt.json())
        );

        expect(
          yield* native(() =>
            first.directory.exec("SELECT user_id FROM session_routes WHERE user_id=?", alice.user)
          )
        ).toEqual([{ user_id: alice.user }]);
        expect(evidence.completed).not.toContain("credentials");
        expect(evidence.completed).not.toContain("identity");
        expect(evidence.completed).not.toContain("billing");
        expect(evidence.completed).toContain("transactions");
        expect(evidence.custodians.map((owner) => owner.status)).toEqual(Array(5).fill("Pending"));
        expect(yield* receivedStatus(history(runtime, bob))).toBe(200);
      })
  );
  test.effect("the independent case waits for an issued anonymous reservation at R2", () =>
    Effect.gen(function* () {
      const runtime = yield* (yield* nativePurgePlatform)();
      const owner = yield* seed(runtime, alice);
      const driver = yield* caseDriver(runtime);

      const user = (yield* native(() =>
        runtime.getDurableObjectNamespace("USER_STORE", "core")
      )).getByName(alice.user);

      const shared = yield* native(() => runtime.getR2Bucket("SAMPLE_BUCKET", "core"));
      const sample = "22510000-0000-4000-8000-000000000033";
      yield* owner.exec(
        "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('grant',?,'processing_grant',?)",
        alice.user,
        owner.now
      );
      yield* native(() => user.fetch("https://fixture.invalid/hold-sample", { method: "POST" }));

      const digest = yield* native(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(anonymousSample))
      );

      yield* owner.exec(
        "INSERT INTO ingest_sample_decisions VALUES('candidate',?,1,?,'issuer','operator',?,?,?,'approved',1)",
        alice.user,
        new Uint8Array(digest).toHex(),
        owner.now,
        sample,
        anonymousSample
      );
      yield* native(() => user.fetch("https://owner.internal/work/check", { method: "POST" }));

      const issued = yield* owner.exec("SELECT nonce FROM ingest_sample_reservations").pipe(
        Effect.repeat({
          until: (rows) => rows.length === 1,
          times: 50,
          schedule: Schedule.spaced("40 millis"),
        })
      );

      expect(issued.length).toBe(1);
      expect(yield* native(() => shared.head("samples/" + sample))).toBeNull();
      expect((yield* admitPurge(runtime)).status).toBe(202);
      yield* driver.step();
      expect(yield* driver.step()).toBe("Draining");
      expect(yield* owner.exec("SELECT nonce FROM ingest_sample_reservations")).toEqual(issued);
      yield* native(() => user.fetch("https://fixture.invalid/release-sample", { method: "POST" }));

      const ended = yield* owner.exec("SELECT nonce FROM ingest_sample_reservations").pipe(
        Effect.repeat({
          until: (rows) => rows.length === 0,
          times: 50,
          schedule: Schedule.spaced("40 millis"),
        })
      );

      expect(ended).toEqual([]);
      yield* owner.exec("UPDATE ingest_sample_decisions SET due_ms=1 WHERE phase='removing'");
      expect(
        yield* driver
          .step()
          .pipe(Effect.repeat({ until: (phase) => phase === "ExternalPending", times: 12 }))
      ).toBe("ExternalPending");
      expect(yield* native(() => shared.head("samples/" + sample))).toBeNull();
    })
  );
  test.effect("hands the exact Resend delivery scope off after a lost page and proof expiry", () =>
    Effect.gen(function* () {
      const runtime = yield* (yield* nativeBillingPlatform)();
      const owner = yield* seed(runtime, alice);
      const work = "22510000-0000-4000-8000-000000000094";
      yield* owner.exec(
        "INSERT INTO email_replacements(user_id,work_id,session_id,prior_key,revision,candidate,created_at_ms,expires_at_ms,state,public_code,proof_digest) VALUES(?,?,?,'old@synthetic.test',1,'pending@synthetic.test',?,?,'awaiting_proof','synthetic-code',X'01')",
        alice.user,
        work,
        alice.session,
        owner.now,
        owner.now + 60000
      );

      const logins = Array.from(
        { length: 17 },
        (_, index) => "22510000-0000-4000-8000-" + String(index).padStart(12, "0")
      );

      yield* Effect.forEach(logins, (key, ordinal) => seedLoginProof(owner, key, ordinal), {
        discard: true,
      });

      const driver = yield* caseDriver(runtime);
      expect((yield* admitPurge(runtime)).status).toBe(202);
      const registry = driver.storage;
      yield* native(() =>
        registry.exec(
          "CREATE TRIGGER hold_mail_page BEFORE INSERT ON erasure_resend_scope BEGIN SELECT RAISE(ABORT,'lost page'); END"
        )
      );
      expect(yield* driver.step().pipe(Effect.repeat({ times: 4 }))).toBe("Draining");
      yield* owner.exec("DELETE FROM email_replacements WHERE work_id=?", work);
      expect(yield* owner.exec("SELECT * FROM erasure_expired_mail")).toEqual([
        { work_id: work, requested_at_ms: owner.now },
      ]);
      yield* native(() => registry.exec("DROP TRIGGER hold_mail_page"));
      expect(
        yield* driver
          .step()
          .pipe(Effect.repeat({ until: (phase) => phase === "ExternalPending", times: 12 }))
      ).toBe("ExternalPending");
      const [entry] = yield* native(() => registry.exec("SELECT reference FROM erasure_cases"));
      expect(
        yield* native(() => registry.exec("SELECT * FROM erasure_resend_scope ORDER BY work_id"))
      ).toEqual([
        ...logins.map((workId) => ({
          reference: entry?.reference,
          work_id: workId,
          requested_at_ms: owner.now,
        })),
        { reference: entry?.reference, work_id: work, requested_at_ms: owner.now },
      ]);
      expect(
        yield* native(() =>
          registry.exec(
            "SELECT observed_use,status FROM erasure_case_custodians WHERE custodian='Resend'"
          )
        )
      ).toEqual([{ observed_use: 1, status: "Pending" }]);
      expect(
        yield* owner.exec("SELECT name FROM sqlite_schema WHERE name='email_replacements'")
      ).toEqual([]);
    })
  );
  test.effect("only matching anonymous published samples survive User erasure", () =>
    Effect.gen(function* () {
      const runtime = yield* (yield* nativeBillingPlatform)();
      const first = yield* seed(runtime, alice);
      const shared = yield* native(() => runtime.getR2Bucket("SAMPLE_BUCKET", "core"));
      const cases = yield* caseDriver(runtime);

      const valid = "22510000-0000-4000-8000-000000000021",
        unsafe = "22510000-0000-4000-8000-000000000022";

      yield* Effect.forEach(
        [
          [valid, anonymousSample],
          [unsafe, '{"sender":"synthetic@example.test"}'],
        ] as const,
        (sample) => publishSample(first, shared, sample),
        { discard: true }
      );

      expect((yield* admitPurge(runtime)).status).toBe(202);
      expect(
        yield* cases
          .step()
          .pipe(Effect.repeat({ until: (phase) => phase === "ExternalPending", times: 12 }))
      ).toBe("ExternalPending");
      const unsafeHead = yield* native(() => shared.head("samples/" + unsafe));
      expect(unsafeHead === null).toBe(true);
      const safeObject = yield* native(() => shared.get("samples/" + valid));

      if (safeObject === null) return yield* Effect.die("Expected anonymous sample");
      expect(yield* native(() => safeObject.text())).toBe(anonymousSample);
    })
  );
  test.effect("the independent case purges only the fenced User and its private originals", () =>
    Effect.gen(function* () {
      const create = yield* nativeBillingPlatform;
      const runtime = yield* create();
      const first = yield* seed(runtime, alice);
      yield* seed(runtime, bob);
      const driver = yield* caseDriver(runtime);
      const registry = driver.storage;
      const originals = yield* native(() => runtime.getR2Bucket("EMAIL_BUCKET", "core"));
      const key = "users/" + alice.user + "/email/synthetic";
      const other = "users/" + bob.user + "/email/synthetic";
      yield* native(() => originals.put(key, "private"));
      yield* native(() => originals.put(other, "other"));
      const nonce = "22510000-0000-4000-8000-000000000001";
      yield* first.exec(
        "INSERT INTO original_writers(nonce,bucket,object_key) VALUES(?,'email',?)",
        nonce,
        key + "-late"
      );
      const sample = "22510000-0000-4000-8000-000000000004";
      const sampleWriter = "22510000-0000-4000-8000-000000000005";
      const shared = yield* native(() => runtime.getR2Bucket("SAMPLE_BUCKET", "core"));
      yield* first.exec(
        "INSERT INTO ingest_sample_decisions VALUES('synthetic',?,1,'digest','issuer','operator',?,?,'{}','approved',0)",
        alice.user,
        first.now,
        sample
      );
      yield* first.exec("INSERT INTO ingest_sample_reservations VALUES(?,?)", sampleWriter, sample);
      yield* first.exec(
        "INSERT INTO whatsapp_deliveries(user_id,family,operation_id,endpoint,correlation,portfolio,bsuid,content_digest,started_ms,state) VALUES(?,'proactivity','synthetic-send','endpoint','correlation','portfolio','recipient','sha',?,'ambiguous')",
        alice.user,
        first.now
      );
      const admission = yield* admitPurge(runtime);
      expect(admission.status).toBe(202);
      yield* driver.step().pipe(Effect.repeat({ times: 3 }));
      expect(yield* native(() => originals.head(key + "-late"))).toBeNull();
      expect(yield* native(() => registry.exec("SELECT state FROM erasure_cases"))).toEqual([
        { state: "Draining" },
      ]);
      expect(yield* first.exec("SELECT nonce FROM original_writers")).toEqual([{ nonce }]);
      yield* native(() =>
        originals.put(key + "-late", "delayed synthetic", { customMetadata: { writer: nonce } })
      );
      yield* driver.step().pipe(Effect.repeat({ times: 3 }));
      expect(yield* native(() => registry.exec("SELECT state FROM erasure_cases"))).toEqual([
        { state: "Draining" },
      ]);

      const placeholder = yield* native(() =>
        shared.put("samples/" + sample, sampleWriter, {
          customMetadata: { purpose: "sample-placeholder", nonce: sampleWriter },
        })
      );

      yield* first.exec("UPDATE ingest_sample_decisions SET due_ms=0 WHERE phase='removing'");
      yield* driver.step().pipe(Effect.repeat({ times: 3 }));
      expect(yield* native(() => registry.exec("SELECT state FROM erasure_cases"))).toEqual([
        { state: "Draining" },
      ]);
      yield* first.exec(
        "UPDATE whatsapp_deliveries SET state='delivered',provider_message_id='synthetic-confirmation' WHERE operation_id='synthetic-send'"
      );
      yield* driver
        .step()
        .pipe(Effect.repeat({ until: (phase) => phase === "ExternalPending", times: 12 }));
      expect(yield* native(() => registry.exec("SELECT state FROM erasure_cases"))).toEqual([
        { state: "ExternalPending" },
      ]);
      expect(
        yield* first.exec(
          "SELECT name FROM sqlite_schema WHERE name IN ('users','web_sessions','erasure_requests')"
        )
      ).toEqual([]);
      expect(
        yield* native(() =>
          registry.exec(
            "SELECT custodian FROM erasure_case_custodians WHERE observed_use=1 ORDER BY custodian"
          )
        )
      ).toEqual([{ custodian: "Cloudflare" }, { custodian: "Kapso" }, { custodian: "Meta" }]);
      expect(yield* native(() => originals.head(key))).toBeNull();
      expect(yield* native(() => originals.head(key + "-late"))).toBeNull();
      expect(yield* native(() => shared.head("samples/" + sample))).toBeNull();
      expect(
        yield* native(() =>
          shared.put("samples/" + sample, "delayed payload", {
            onlyIf: { etagMatches: placeholder.etag },
          })
        )
      ).toBeNull();
      expect(yield* native(() => originals.head(other))).not.toBeNull();
      expect(yield* receivedStatus(history(runtime, bob))).toBe(200);
      yield* native(() =>
        runtime.unsafeEvictDurableObject("core", "UserStore", { name: alice.user })
      );
      expect(yield* receivedStatus(history(runtime))).toBe(401);
      expect(yield* first.exec("SELECT name FROM sqlite_schema WHERE name='users'")).toEqual([]);
    })
  );
  test.effect(
    "preserves Resend custody after approved and ambiguous proofs clear the selector",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBillingPlatform)();
        const owner = yield* seed(runtime, alice);
        const approved = "22510000-0000-4000-8000-000000000095";
        const ambiguous = "22510000-0000-4000-8000-000000000096";

        yield* Effect.forEach(
          [
            [approved, "approved", 501],
            [ambiguous, "ambiguous", 502],
          ] as const,
          ([work, state, ordinal]) => seedDeliveredProof(owner, [work, state, ordinal]),
          { discard: true }
        );

        expect((yield* admitPurge(runtime)).status).toBe(202);
        expect(yield* owner.exec("SELECT resend FROM local_erasure_custody")).toEqual([
          { resend: 1 },
        ]);
        expect(
          yield* owner.exec(
            "SELECT work_id FROM erasure_mail_scope WHERE work_id IN (?,?) ORDER BY work_id",
            approved,
            ambiguous
          )
        ).toEqual([{ work_id: approved }, { work_id: ambiguous }]);

        yield* owner.exec(
          "DELETE FROM login_email_proofs WHERE work_id IN (?,?)",
          approved,
          ambiguous
        );
        expect(
          yield* owner.exec(
            "SELECT work_id FROM erasure_expired_mail WHERE work_id IN (?,?) ORDER BY work_id",
            approved,
            ambiguous
          )
        ).toEqual([{ work_id: approved }, { work_id: ambiguous }]);
      })
  );
});
