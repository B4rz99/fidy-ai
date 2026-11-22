import type { Miniflare } from "miniflare";
import { SampleReviewResult } from "../../src/core/ingestion/contract";
import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { alice, seed } from "../financial-user-store.test-fixture";
import { native, nativeBrowserPlatform } from "../user-store.test-fixture";

const scenario = Effect.fn(function* () {
  const runtime = yield* (yield* nativeBrowserPlatform)();
  const owner = yield* seed(runtime, alice, false);
  const id = "10000000-0000-4000-8000-000000000096";
  const receipt = "10000000-0000-4000-8000-000000000097";
  yield* owner.exec(
    "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('grant',?,'processing_grant',?)",
    alice.user,
    owner.now
  );
  yield* owner.exec(
    "INSERT INTO forwarded_email_receipts(id,user_id,received_at_ms,expires_at_ms) VALUES(?,?,?,?)",
    receipt,
    alice.user,
    owner.now,
    owner.now + 7776000000
  );
  const structure = '{"table":1,"tr":1,"td":2,"p":1,"span":0,"div":0}';
  yield* owner.exec(
    "INSERT INTO ingest_sample_candidates VALUES(?,?,?,1,'CO','notification-email','cloudflare-email','cloudflare-mime-v1','structural-tags-v1',?,?)",
    id,
    alice.user,
    receipt,
    structure,
    owner.now + 7776000000
  );

  const { FIXTURE_PROVIDER: signer } = yield* native(() =>
    runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
  );

  const token = yield* native(() =>
    signer.fetch("https://fixture.invalid/reviewer-assertion").then((res) => res.text())
  );

  const post = (body: unknown): Effect.Effect<Awaited<ReturnType<Miniflare["dispatchFetch"]>>> =>
    native(() =>
      runtime.dispatchFetch("https://api.fidyapp.com/internal/sample-review", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
        body: JSON.stringify(body),
      })
    );

  return { runtime, owner, id, receipt, structure, post };
});

const previewCandidate = Effect.fn(function* (
  post: Effect.Success<ReturnType<typeof scenario>>["post"]
) {
  const preview = yield* post({ action: "preview", userId: alice.user });
  expect(preview.status).toBe(200);

  const view = yield* Schema.decodeUnknownEffect(SampleReviewResult, {
    onExcessProperty: "error",
  })(yield* native(() => preview.json()));

  if (view.status !== "preview") return yield* Effect.die("Expected preview");

  return view;
});

type Owner = Effect.Success<ReturnType<typeof scenario>>["owner"];

const resumeSample = Effect.fn(function* (
  owner: Owner,
  users: Awaited<ReturnType<Miniflare["getDurableObjectNamespace"]>>
) {
  yield* owner.exec("UPDATE ingest_sample_decisions SET due_ms=0 WHERE due_ms IS NOT NULL");
  yield* native(() =>
    users.getByName(alice.user).fetch("https://owner.internal/work/check", { method: "POST" })
  );
});

const waitPhase = Effect.fn(function* (owner: Owner, expected: string) {
  return yield* owner.exec("SELECT phase FROM ingest_sample_decisions").pipe(
    Effect.filterOrFail(
      (rows) => rows[0]?.phase === expected,
      () => "pending"
    ),
    Effect.retry({ times: 80, schedule: Schedule.spaced("50 millis") })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("requires the dedicated human reviewer Access capability at public ingress", () =>
    Effect.gen(function* () {
      const runtime = yield* (yield* nativeBrowserPlatform)();

      const { FIXTURE_PROVIDER: signer } = yield* native(() =>
        runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
      );

      const signed = yield* native(() => signer.fetch("https://fixture.invalid/support-assertion"));
      const token = yield* native(() => signed.text());

      const denied = yield* native(() =>
        runtime.dispatchFetch("https://api.fidyapp.com/internal/sample-review", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
        })
      );

      expect(denied.status).toBe(401);

      const reviewer = yield* native(() =>
        signer.fetch("https://fixture.invalid/reviewer-assertion")
      );

      const assertion = yield* native(() => reviewer.text());

      const recovery = yield* native(() =>
        runtime.dispatchFetch("https://api.fidyapp.com/internal/support-recovery", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-access-jwt-assertion": assertion },
        })
      );

      expect(recovery.status).toBe(401);

      const unauthenticated = yield* native(() =>
        runtime.dispatchFetch("https://api.fidyapp.com/internal/sample-review", {
          method: "POST",
          headers: { "content-type": "application/json" },
        })
      );

      expect(unauthenticated.status).toBe(401);
    })
  );

  const invalidReviewClaims = ["multiple", "organization", "unassigned"];

  const testInvalidReviewClaim = (invalidClaim: (typeof invalidReviewClaims)[number]): void => {
    test.effect(`refuses a signed review assertion with ${invalidClaim} authority`, () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBrowserPlatform)();

        const { FIXTURE_PROVIDER: signer } = yield* native(() =>
          runtime.getBindings<{ FIXTURE_PROVIDER: Fetcher }>("core")
        );

        const signed = yield* native(() =>
          signer.fetch("https://fixture.invalid/reviewer-assertion?scenario=" + invalidClaim)
        );

        const assertion = yield* native(() => signed.text());

        const refused = yield* native(() =>
          runtime.dispatchFetch("https://api.fidyapp.com/internal/sample-review", {
            method: "POST",
            headers: { "cf-access-jwt-assertion": assertion },
          })
        );

        expect(refused.status).toBe(401);
      })
    );
  };

  invalidReviewClaims.forEach(testInvalidReviewClaim);

  test.effect(
    "reviews and publishes only an exact structural revision from the originating User",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, id, receipt, structure, post } = yield* scenario();
        const view = yield* previewCandidate(post);
        expect(view).toMatchObject({
          status: "preview",
          candidateId: id,
          revision: 1,
          artifact: { structure: { table: 1, tr: 1, td: 2, p: 1, span: 0, div: 0 } },
        });
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(view)
        ).not.toContain(receipt);

        const approve = {
          action: "approve",
          userId: alice.user,
          candidateId: id,
          revision: 1,
          digest: view.digest,
        };

        expect((yield* post({ ...approve, revision: 2 })).status).toBe(409);
        yield* owner.exec(
          "UPDATE ingest_sample_candidates SET structure=?",
          structure.replace("2", "3")
        );
        expect((yield* post(approve)).status).toBe(409);
        yield* owner.exec("UPDATE ingest_sample_candidates SET structure=?", structure);
        yield* owner.exec(
          "CREATE TRIGGER lost_sample_ack BEFORE UPDATE OF phase ON ingest_sample_decisions WHEN NEW.phase='published' BEGIN SELECT RAISE(ABORT,'fixture_lost_ack'); END"
        );
        expect((yield* post(approve)).status).toBe(503);

        const [intent] = yield* owner.exec(
          "SELECT sample_id,phase,operator,issuer,artifact FROM ingest_sample_decisions"
        );

        expect(intent).toMatchObject({
          phase: "approved",
          operator: "fixture-operator",
          issuer: "https://fixture.cloudflareaccess.com",
        });
        const bucket = yield* native(() => runtime.getR2Bucket("SAMPLE_BUCKET", "core"));

        const uncertain = yield* native(() =>
          bucket.get("samples/" + Schema.decodeUnknownSync(Schema.String)(intent?.sample_id))
        );

        if (uncertain === null) return yield* Effect.die("Expected uncertain R2 object");
        const firstVersion = uncertain.version;
        expect(yield* native(() => uncertain.text())).toBe(intent?.artifact);
        yield* owner.exec("DROP TRIGGER lost_sample_ack");
        const accepted = yield* post(approve);
        expect(accepted.status).toBe(200);

        const result = yield* Schema.decodeUnknownEffect(SampleReviewResult)(
          yield* native(() => accepted.json())
        );

        if (!("sampleId" in result)) return yield* Effect.die("Expected sample identity");
        expect(result.sampleId).not.toBe(id);
        expect(result.sampleId).toBe(intent?.sample_id);
        const object = yield* native(() => bucket.get("samples/" + result.sampleId));
        expect(object?.version).toBe(firstVersion);
        expect(object?.customMetadata).toEqual({ purpose: "anonymous-ingest-sample" });

        if (object === null) return yield* Effect.die("Expected shared sample");
        expect(yield* native(() => object.text())).toBe(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(view.artifact)
        );
        const replay = yield* post(approve);
        expect(yield* native(() => replay.json())).toEqual({
          status: "published",
          sampleId: result.sampleId,
        });
        expect((yield* post({ action: "withdraw", sampleId: result.sampleId })).status).toBe(200);
        expect(yield* native(() => bucket.head("samples/" + result.sampleId))).toBeNull();
        expect((yield* post(approve)).status).toBe(409);
      })
  );

  test.effect(
    "rejects the reviewed version, refuses identifying fields and enforces original expiry",
    () =>
      Effect.gen(function* () {
        const { owner, post, structure, id } = yield* scenario();
        yield* owner.exec(
          "UPDATE ingest_sample_candidates SET structure=?",
          structure.replace("}", ',"sender":"private@example.test"}')
        );
        const invalid = yield* post({ action: "preview", userId: alice.user });
        expect(invalid.status).toBe(503);
        expect(yield* native(() => invalid.text())).not.toContain("private@example.test");
        yield* owner.exec("UPDATE ingest_sample_candidates SET structure=?", structure);
        const view = yield* previewCandidate(post);

        const reject = {
          action: "reject",
          userId: alice.user,
          candidateId: id,
          revision: view.revision,
          digest: view.digest,
        };

        yield* owner.exec("UPDATE forwarded_email_receipts SET expires_at_ms=0");
        expect((yield* post(reject)).status).toBe(409);
        yield* owner.exec(
          "UPDATE forwarded_email_receipts SET expires_at_ms=?",
          owner.now + 7776000000
        );
        expect((yield* post(reject)).status).toBe(200);
        expect((yield* post({ ...reject, action: "approve" })).status).toBe(409);
        expect(
          yield* owner.exec("SELECT phase,artifact,sample_id,operator FROM ingest_sample_decisions")
        ).toEqual([
          { phase: "rejected", artifact: null, sample_id: null, operator: "fixture-operator" },
        ]);
        expect(yield* owner.exec("SELECT id FROM ingest_sample_candidates")).toEqual([]);
      })
  );
  test.effect(
    "keeps the erasure drain pending on a missing object until the delayed reservation actually lands",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, post, id } = yield* scenario();
        const view = yield* previewCandidate(post);
        yield* owner.exec(
          "CREATE TRIGGER stop_sample_reservation BEFORE DELETE ON ingest_sample_reservations BEGIN SELECT RAISE(ABORT,'fixture_lost_reply'); END"
        );

        const decision = {
          action: "approve",
          userId: alice.user,
          candidateId: id,
          revision: view.revision,
          digest: view.digest,
        };

        expect((yield* post(decision)).status).toBe(503);
        const [claim] = yield* owner.exec("SELECT sample_id,nonce FROM ingest_sample_reservations");

        const writer = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ sample_id: Schema.String, nonce: Schema.String })
        )(claim);

        const key = "samples/" + writer.sample_id;
        const bucket = yield* native(() => runtime.getR2Bucket("SAMPLE_BUCKET", "core"));
        yield* native(() => bucket.delete(key));
        yield* owner.exec(
          "INSERT INTO erasure_requests(id,user_id,state) VALUES('synthetic-erasure',?,'Draining')",
          alice.user
        );
        yield* owner.exec("DROP TRIGGER stop_sample_reservation");
        expect((yield* post(decision)).status).toBe(403);
        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
        yield* resumeSample(owner, users);
        yield* waitPhase(owner, "removing");
        expect(yield* owner.exec("SELECT nonce FROM ingest_sample_reservations")).toEqual([
          { nonce: writer.nonce },
        ]);

        const late = yield* native(() =>
          bucket.put(key, writer.nonce, {
            onlyIf: { etagDoesNotMatch: "*" },
            customMetadata: { purpose: "sample-placeholder", nonce: writer.nonce },
          })
        );

        expect(late).toBeDefined();
        yield* resumeSample(owner, users);
        yield* waitPhase(owner, "withdrawn");
        expect(yield* native(() => bucket.head(key))).toBeNull();
        expect(
          yield* native(() =>
            bucket.put(key, "delayed payload", { onlyIf: { etagMatches: late.etag } })
          )
        ).toBeNull();
        expect(yield* owner.exec("SELECT nonce FROM ingest_sample_reservations")).toEqual([]);
      })
  );
});
