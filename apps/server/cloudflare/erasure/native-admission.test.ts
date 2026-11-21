import { digestVerifier } from "../browser-login/operations";
import { participantFenceUrl } from "../erasure-store/contract";
import { directoryName, externalReserveUrl } from "../directory/contract";
import { BillingRegistration } from "../subscription/contract";
import type { Miniflare } from "miniflare";
import { ErasureReceipt } from "../../src/core/erasure/contract";
import { ownerCheckUrl } from "../maintenance/contract";
import { erasureRegistryName } from "./contract";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import {
  alice,
  bob,
  history,
  nativeBrowserWrite,
  nativeTransactionJourney,
  receivedStatus,
  seed,
} from "../financial-user-store.test-fixture";
import { native, nativeUserPlatform } from "../user-store.test-fixture";
import { browserOrigins, productionTopology } from "../runtime/contract";

const erase = (
  runtime: Miniflare,
  subject = alice,
  body: unknown = { confirm: true }
): ReturnType<typeof history> =>
  native(() =>
    runtime.dispatchFetch(`https://${productionTopology.ingress.hostname}/web/privacy/erasure`, {
      method: "POST",
      headers: {
        origin: browserOrigins.production,
        "content-type": "application/json",
        "Fidy-Session-Binding": subject.session,
        cookie: `__Host-fidy_session=${subject.bearer}`,
      },
      body: JSON.stringify(body),
    })
  );

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("a fresh bound browser fences just its User and replays the same receipt", () =>
    Effect.gen(function* () {
      const create = yield* nativeUserPlatform;
      const runtime = yield* create();
      const first = yield* seed(runtime, alice);
      const pairing = "22500000-0000-4000-8000-000000000001";
      const attempt = "22500000-0000-4000-8000-000000000002";
      const privateVerifier = "z".repeat(43);
      const digest = yield* digestVerifier(privateVerifier);

      const subject = (yield* native(() =>
        runtime.getDurableObjectNamespace("USER_STORE", "core")
      )).getByName(alice.user);

      const command = (path: string, body: unknown): ReturnType<typeof history> =>
        native(() =>
          subject.fetch("https://user.invalid/" + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        );

      const bootstrap = { id: attempt, pairingId: pairing, privateVerifier };

      yield* native(() =>
        first.directory.exec(
          "INSERT INTO browser_pairings(id,public_code,verifier_digest,expires_at_ms,user_id) VALUES(?,'ABC123',?,?,?)",
          pairing,
          digest,
          first.now + 60000,
          alice.user
        )
      );
      yield* native(() =>
        first.directory.exec(
          "INSERT INTO provider_attempts(id,pairing_id,provider,cookie_digest,nonce,intent,expires_at_ms,state,issuer,subject) VALUES(?,?,'google',zeroblob(32),'','signup',?,'bound','test-issuer','old-subject')",
          attempt,
          pairing,
          first.now + 60000
        )
      );
      yield* native(() =>
        first.directory.exec(
          "INSERT INTO provider_routes(issuer,subject,user_id,creation_attempt) VALUES('test-issuer','old-subject',?,?)",
          alice.user,
          attempt
        )
      );

      expect((yield* command("bootstrap/status", bootstrap)).status).toBe(200);
      const ready = "22500000-0000-4000-8000-000000000003";
      yield* first.exec(
        "INSERT INTO browser_handoffs(id,pairing_id,user_id,ordinal,verifier_digest,expires_at_ms,wrong_attempts,minimum_poll_seconds,outcome,state) VALUES(?,?,?,10,?,?,0,5,'committed','ready')",
        ready,
        ready,
        alice.user,
        digest,
        first.now + 60000
      );
      yield* seed(runtime, bob);
      const response = yield* erase(runtime);
      expect(response.status).toBe(202);
      expect((yield* command("bootstrap/complete", bootstrap)).ok).toBe(false);
      const redemption = yield* command("browser/redeem", { pairingId: ready, privateVerifier });
      expect(redemption.ok).toBe(false);
      expect(redemption.headers.get("set-cookie")).toBeNull();
      expect(yield* first.exec("SELECT count(*) AS count FROM web_sessions")).toEqual([
        { count: 1 },
      ]);

      const receipt = yield* Schema.decodeUnknownEffect(ErasureReceipt)(
        yield* native(() => response.json())
      );

      expect(receipt).toMatchObject({ state: "Draining", next: "admitted-work" });
      const replay = yield* erase(runtime);
      expect(replay.status).toBe(202);
      expect(yield* native(() => replay.json())).toEqual(receipt);
      expect(yield* receivedStatus(history(runtime, alice))).toBe(401);
      expect(yield* receivedStatus(history(runtime, bob))).toBe(200);

      const registry = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Erasure", { name: "erasure-registry-v1" })
      );

      const cases = yield* native(() =>
        registry.exec("SELECT user_id,reference,state FROM erasure_cases")
      );

      expect(cases).toEqual([
        { user_id: alice.user, reference: receipt.reference, state: "Draining" },
      ]);

      const barriers = yield* native(() =>
        registry.exec(
          "SELECT directory_fenced,pricing_fenced,maintenance_fenced FROM erasure_cases"
        )
      ).pipe(
        Effect.repeat({
          until: (rows) =>
            rows[0]?.maintenance_fenced === 1 &&
            rows[0].directory_fenced === 1 &&
            rows[0].pricing_fenced === 1,
          times: 15,
          schedule: Schedule.spaced("100 millis"),
        })
      );

      expect(barriers).toEqual([{ directory_fenced: 1, pricing_fenced: 1, maintenance_fenced: 1 }]);

      const outcome = yield* native(() =>
        first.directory.exec("SELECT state FROM provider_attempts WHERE id=?", attempt)
      ).pipe(
        Effect.repeat({
          until: (rows) => rows[0]?.state === "cancelled",
          times: 30,
          schedule: Schedule.spaced("100 millis"),
        })
      );

      expect(outcome).toEqual([{ state: "cancelled" }]);
      expect(
        yield* native(() =>
          first.directory.exec(
            "SELECT user_id,creation_attempt FROM provider_routes WHERE subject='old-subject'"
          )
        )
      ).toEqual([{ user_id: alice.user, creation_attempt: attempt }]);
      expect(yield* first.exec("SELECT outcome FROM browser_handoffs WHERE id=?", attempt)).toEqual(
        [{ outcome: "cancelled" }]
      );
    })
  );

  test.effect(
    "only the admitting browser can replay after hosted and Connection writes are fenced",
    () =>
      Effect.gen(function* () {
        const journey = yield* nativeTransactionJourney;

        const otherSession = {
          user: alice.user,
          session: "22500000-0000-4000-8000-000000000021",
          bearer: "d".repeat(43),
        };

        const digest = yield* native(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(otherSession.bearer))
        );

        yield* native(() =>
          journey.directory.exec(
            "INSERT INTO session_routes SELECT ?,user_id,?,?,hard_expires_at_ms FROM session_routes WHERE session_id=?",
            digest,
            otherSession.session,
            otherSession.session,
            alice.session
          )
        );
        yield* native(() =>
          journey.exec(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) SELECT ?,?,user_id,?,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms FROM web_sessions WHERE id=?",
            otherSession.session,
            otherSession.session,
            digest,
            alice.session
          )
        );
        expect(yield* receivedStatus(history(journey.runtime, otherSession))).toBe(200);
        expect((yield* erase(journey.runtime)).status).toBe(202);
        expect((yield* erase(journey.runtime, otherSession)).status).toBe(409);
        const write = nativeBrowserWrite(journey);
        expect(
          (yield* write(alice, {
            method: "POST",
            path: "/web/hosted-turns",
            body: { text: "Mi presupuesto" },
          })).status
        ).toBe(401);
        expect(
          (yield* write(alice, {
            method: "POST",
            path: "/connections",
            body: { institutionId: "bancolombia" },
          })).status
        ).toBe(401);
        expect(
          yield* native(() =>
            journey.exec(
              "SELECT (SELECT count(*) FROM hosted_turns) AS turns,(SELECT count(*) FROM connections) AS connections,(SELECT count(*) FROM erasure_requests) AS requests"
            )
          )
        ).toEqual([{ turns: 0, connections: 0, requests: 1 }]);
      })
  );

  test.effect(
    "a failed independent registration and a lost local acknowledgement recover exactly once",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);
        const other = yield* seed(runtime, bob);

        const cases = (yield* native(() =>
          runtime.getDurableObjectNamespace("ERASURE", "core")
        )).getByName(erasureRegistryName);

        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
        yield* native(() => cases.fetch(ownerCheckUrl, { method: "POST" }));

        const registry = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Erasure", { name: erasureRegistryName })
        );

        yield* native(() =>
          registry.exec(
            "CREATE TRIGGER case_outage BEFORE INSERT ON erasure_cases BEGIN SELECT RAISE(ABORT,'fixture'); END"
          )
        );
        expect((yield* erase(runtime, alice, { confirm: true, userId: bob.user })).status).toBe(
          400
        );
        expect(yield* other.exec("SELECT * FROM erasure_requests")).toEqual([]);
        yield* other.exec(
          "UPDATE web_sessions SET created_at_ms=created_at_ms-700000,fresh_until_ms=fresh_until_ms-700000,hard_expires_at_ms=hard_expires_at_ms-700000"
        );
        expect((yield* erase(runtime, bob)).status).toBe(401);
        const accepted = yield* erase(runtime);

        const receipt = yield* Schema.decodeUnknownEffect(ErasureReceipt)(
          yield* native(() => accepted.json())
        );

        expect(yield* native(() => registry.exec("SELECT reference FROM erasure_cases"))).toEqual(
          []
        );
        expect(yield* receivedStatus(history(runtime))).toBe(401);
        yield* native(() => registry.exec("DROP TRIGGER case_outage"));
        yield* owner.exec(
          "CREATE TRIGGER lose_reply BEFORE UPDATE OF handoff_due_ms ON erasure_requests WHEN NEW.handoff_due_ms IS NULL BEGIN SELECT RAISE(ABORT,'fixture'); END"
        );
        yield* owner.exec("UPDATE erasure_requests SET handoff_due_ms=1");
        yield* native(() => users.getByName(alice.user).fetch(ownerCheckUrl, { method: "POST" }));
        const expected = [{ reference: receipt.reference, user_id: alice.user }];

        const saved = yield* native(() =>
          registry.exec("SELECT reference,user_id FROM erasure_cases")
        ).pipe(
          Effect.repeat({
            until: (rows) => rows.length === 1,
            times: 30,
            schedule: Schedule.spaced("100 millis"),
          })
        );

        expect(saved).toEqual(expected);
        expect(
          yield* owner.exec(
            "SELECT count(*) AS pending FROM erasure_requests WHERE handoff_due_ms IS NOT NULL"
          )
        ).toEqual([{ pending: 1 }]);
        yield* owner.exec("DROP TRIGGER lose_reply");
        yield* owner.exec("UPDATE erasure_requests SET handoff_due_ms=1");
        yield* native(() => users.getByName(alice.user).fetch(ownerCheckUrl, { method: "POST" }));

        const ack = yield* owner
          .exec("SELECT count(*) AS pending FROM erasure_requests WHERE handoff_due_ms IS NOT NULL")
          .pipe(
            Effect.repeat({
              until: (rows) => rows[0]?.pending === 0,
              times: 30,
              schedule: Schedule.spaced("100 millis"),
            })
          );

        expect(ack).toEqual([{ pending: 0 }]);
        const now = yield* Clock.currentTimeMillis;

        const inspect = (userId: string, deadlineMs: number): ReturnType<typeof history> =>
          native(() =>
            cases.fetch("https://coordinator.internal/erasure-receipt", {
              method: "POST",
              body: JSON.stringify({
                reference: receipt.reference,
                userId,
                deadlineMs,
                authority: {
                  permission: "titular.erase",
                  operatorRef: "fixture",
                  expiresAtMs: now + 60000,
                },
              }),
            })
          );

        expect((yield* inspect(bob.user, now + 4000)).status).toBe(409);
        expect((yield* inspect(alice.user, now - 1)).status).toBe(409);
        const proof = yield* inspect(alice.user, now + 4000);
        expect(yield* native(() => proof.json())).toMatchObject({
          reference: receipt.reference,
          state: "Draining",
          next: "admitted-work",
          completed: [],
          recoveryUntilMs: null,
        });
        expect(
          yield* native(() => registry.exec("SELECT reference,user_id FROM erasure_cases"))
        ).toEqual(expected);
      })
  );

  test.effect(
    "fenced Pricing reconciles the original operation, retains uncertainty and admits unrelated Users",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeUserPlatform)();
        const first = yield* seed(runtime, alice);

        const pricing = (yield* native(() =>
          runtime.getDurableObjectNamespace("PRICING", "core")
        )).getByName("pricing");

        const makeRegistration = (id: string, userId: string): typeof BillingRegistration.Type =>
          Schema.decodeSync(BillingRegistration)({
            operationId: id,
            userId,
            billingPeriod: "monthly",
            admission: { kind: "renewal", previousPaidAttemptId: id },
            inputsDigest: "a".repeat(64),
            deadlineMs: first.now + 60000,
          });

        const register = (body: typeof BillingRegistration.Type): ReturnType<typeof history> =>
          native(() =>
            pricing.fetch("https://pricing.internal/register", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          );

        const known = makeRegistration("22500000-0000-4000-8000-000000000012", alice.user);
        const unknown = makeRegistration("22500000-0000-4000-8000-000000000013", alice.user);
        const third = makeRegistration("22500000-0000-4000-8000-000000000014", bob.user);
        const registered = yield* register(known);
        expect(registered.status).toBe(200);
        expect((yield* register(unknown)).status).toBe(200);

        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(BillingRegistration))(
          known
        );

        yield* first.exec(
          "INSERT INTO billing_admissions(operation_id,user_id,subject_id,request) VALUES(?,?,?,?)",
          known.operationId,
          alice.user,
          known.operationId,
          encoded
        );
        const accepted = yield* erase(runtime);

        const receipt = yield* Schema.decodeUnknownEffect(ErasureReceipt)(
          yield* native(() => accepted.json())
        );

        const outcomes = yield* first
          .exec("SELECT operation_id,outcome FROM billing_admissions ORDER BY operation_id")
          .pipe(
            Effect.repeat({
              until: (rows) => rows[0]?.outcome === "cancelled",
              times: 40,
              schedule: Schedule.spaced("100 millis"),
            })
          );

        expect(outcomes).toEqual([{ operation_id: known.operationId, outcome: "cancelled" }]);

        const unknownRequest = yield* Schema.encodeEffect(
          Schema.fromJsonString(BillingRegistration)
        )(unknown);

        yield* first.exec(
          "INSERT INTO billing_admissions(operation_id,user_id,subject_id,request,terms,outcome,report) VALUES(?,?,?,?,?,'committed',?)",
          unknown.operationId,
          alice.user,
          unknown.operationId,
          unknownRequest,
          "{}",
          "{}"
        );
        const owners = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

        const recovered = yield* native(() =>
          owners.getByName(alice.user).fetch("https://user.invalid/billing/registration-outcome", {
            method: "POST",
            body: unknownRequest,
          })
        );

        expect(recovered.status).toBe(200);
        const ack = yield* native(() => recovered.text());
        expect(
          (yield* native(() =>
            pricing.fetch("https://pricing.internal/ack", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: ack,
            })
          )).status
        ).toBe(204);
        expect((yield* register(known)).ok).toBe(false);
        expect((yield* register(third)).status).toBe(200);

        const directory = (yield* native(() =>
          runtime.getDurableObjectNamespace("DIRECTORY", "core")
        )).getByName(directoryName);

        const wrong = { userId: bob.user, reference: receipt.reference, requestedAtMs: first.now };
        expect(
          (yield* native(() =>
            directory.fetch(participantFenceUrl, { method: "POST", body: JSON.stringify(wrong) })
          )).ok
        ).toBe(false);
        const issuedAt = yield* Clock.currentTimeMillis;

        const external = (userId: string): ReturnType<typeof history> =>
          native(() =>
            directory.fetch(externalReserveUrl, {
              method: "POST",
              headers: { "fidy-route-issued-ms": String(issuedAt) },
              body: JSON.stringify({
                userId,
                operationId: known.operationId,
                kind: "wompi",
                family: "billing",
                endpoint: "sandbox",
                lookup: "fidy-" + known.operationId,
              }),
            })
          );

        expect((yield* external(alice.user)).ok).toBe(false);
        expect((yield* external(bob.user)).status).toBe(204);
      })
  );
});
