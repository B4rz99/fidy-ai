import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import { alice, bob, seed } from "../financial-user-store.test-fixture";
import { browserOrigins } from "../runtime/contract";
import { native, nativeUserPlatform } from "../user-store.test-fixture";

type TransportResult = Effect.Effect<Awaited<ReturnType<Miniflare["dispatchFetch"]>>>;
it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "admits an anonymous CLI pairing and polls its private proof before User handoff",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const post = (path: string, payload: unknown): TransportResult =>
          native(() =>
            runtime.dispatchFetch("https://api.fidyapp.com" + path, {
              method: "POST",
              headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.35" },
              body: JSON.stringify(payload),
            })
          );
        const started = yield* post("/pat-pairings", {
          recipientLabel: "CLI",
          scopes: ["read"],
          lifetimeDays: 7,
        });
        expect(started.status).toBe(200);
        const proof = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ pairingId: Schema.String, privateDeviceCode: Schema.String })
        )(yield* native(() => started.json()));
        const pending = yield* post("/pat-pairings/claim", proof);
        expect(pending.status).toBe(202);
        expect(yield* native(() => pending.json())).toMatchObject({
          status: "pending_approval",
          pollingIntervalSeconds: 5,
        });
        const tooSoon = yield* post("/pat-pairings/claim", proof);
        expect(tooSoon.status).toBe(429);
        yield* native(() => tooSoon.text());
      })
  );
  test.effect("revokes an unclaimed pairing after five wrong device proofs", () =>
    Effect.gen(function* () {
      const create = yield* nativeUserPlatform;
      const runtime = yield* create();
      const post = (path: string, payload: unknown): TransportResult =>
        native(() =>
          runtime.dispatchFetch("https://api.fidyapp.com" + path, {
            method: "POST",
            headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.35" },
            body: JSON.stringify(payload),
          })
        );
      const started = yield* post("/pat-pairings", {
        recipientLabel: "CLI",
        scopes: ["read"],
        lifetimeDays: 7,
      });
      expect(started.status).toBe(200);
      const proof = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ pairingId: Schema.String, privateDeviceCode: Schema.String })
      )(yield* native(() => started.json()));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const wrong = yield* post("/pat-pairings/claim", {
          pairingId: proof.pairingId,
          privateDeviceCode: "x".repeat(43),
        });
        expect(wrong.status).toBe(400);
        yield* native(() => wrong.text());
      }
      const dead = yield* post("/pat-pairings/claim", proof);
      expect(dead.status).toBe(400);
      yield* native(() => dead.text());
      const directory = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
      );
      expect(yield* native(() => directory.exec("SELECT id FROM pat_bootstrap"))).toEqual([]);
    })
  );
  test.effect(
    "runs both eligible PAT pairing batch children under the live browser and issues the bearer only to its device",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);
        const send = (path: string, payload: unknown, browser = false): TransportResult =>
          native(() =>
            runtime.dispatchFetch("https://api.fidyapp.com" + path, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "cf-connecting-ip": "192.0.2.35",
                ...(browser
                  ? {
                      origin: browserOrigins.production,
                      cookie: "__Host-fidy_session=" + alice.bearer,
                      "Fidy-Session-Binding": alice.session,
                    }
                  : {}),
              },
              body: JSON.stringify(payload),
            })
          );
        const start = yield* send("/pat-pairings", {
          recipientLabel: "CLI",
          scopes: ["read"],
          lifetimeDays: 7,
        });
        const pairing = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            pairingId: Schema.String,
            publicCode: Schema.String,
            privateDeviceCode: Schema.String,
          })
        )(yield* native(() => start.json()));
        const batch = (operation: string, payload: unknown): TransportResult =>
          send(
            "/operations/atomic-batch",
            {
              calls: [
                { callId: "816551ab-a25e-4167-b87c-f7cc68890161", operation, input: { payload } },
              ],
            },
            true
          );
        const review = yield* batch("pats.inspectPATPairing", { publicCode: pairing.publicCode });
        expect(review.status).toBe(200);
        expect(yield* native(() => review.json())).toMatchObject({
          data: {
            results: [
              {
                output: {
                  data: {
                    pairingId: pairing.pairingId,
                    recipientLabel: "CLI",
                    scopes: ["read"],
                    lifetimeDays: 7,
                  },
                },
              },
            ],
          },
        });
        const approval = yield* batch("pats.approvePATPairing", { pairingId: pairing.pairingId });
        expect(approval.status).toBe(200);
        yield* native(() => approval.text());
        const wrong = yield* send("/pat-pairings/claim", {
          pairingId: pairing.pairingId,
          privateDeviceCode: "x".repeat(43),
        });
        expect(wrong.status).toBe(400);
        yield* native(() => wrong.text());
        const proof = {
          pairingId: pairing.pairingId,
          privateDeviceCode: pairing.privateDeviceCode,
        };
        const claim = yield* send("/pat-pairings/claim", proof);
        expect(claim.status).toBe(200);
        const issued = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ bearer: Schema.String, pat: Schema.Struct({ shortId: Schema.String }) })
        )(yield* native(() => claim.json()));
        expect(
          yield* native(() =>
            owner.directory.exec(
              "SELECT user_id FROM pat_routes WHERE short_id=?",
              issued.pat.shortId
            )
          )
        ).toEqual([{ user_id: alice.user }]);
        const consumed = yield* send("/pat-pairings/claim", proof);
        expect(consumed.status).toBe(400);
        expect(yield* native(() => consumed.text())).not.toContain(issued.bearer);
      })
  );
  test.effect(
    "manual issuance survives a lost reply without redisclosure and refuses a revoked or foreign PAT",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);
        yield* seed(runtime, bob);
        const browser = (
          path: string,
          subject: typeof alice,
          options: { method: "GET" | "DELETE" } | { method: "POST"; body: unknown }
        ): TransportResult =>
          native(() =>
            runtime.dispatchFetch("https://api.fidyapp.com" + path, {
              method: options.method,
              headers: {
                origin: browserOrigins.production,
                cookie: "__Host-fidy_session=" + subject.bearer,
                "Fidy-Session-Binding": subject.session,
                "content-type": "application/json",
                "cf-connecting-ip": "192.0.2.35",
              },
              ...(options.method === "POST" ? { body: JSON.stringify(options.body) } : {}),
            })
          );
        const payload = {
          requestId: "816551ab-a25e-4167-b87c-f7cc68890071",
          grant: {
            recipientLabel: "CLI",
            scopes: ["write"],
            lifetimeDays: 7,
            reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(owner.now + 604800000)),
          },
        };
        const first = yield* browser("/pats", alice, { method: "POST", body: payload });
        expect(first.status).toBe(200);
        const issued = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({
              bearer: Schema.String,
              pat: Schema.Struct({ shortId: Schema.String }),
            }),
          })
        )(yield* native(() => first.json()));
        const repeated = yield* browser("/pats", alice, { method: "POST", body: payload });
        expect(repeated.status).toBe(409);
        expect(yield* native(() => repeated.text())).not.toContain(issued.data.bearer);
        const list = yield* browser("/pats", alice, { method: "GET" });
        expect(list.status).toBe(200);
        const dates = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ created_at_ms: Schema.Int, expires_at_ms: Schema.Int })])
        )(
          yield* owner.exec(
            "SELECT created_at_ms,expires_at_ms FROM pats WHERE short_id=?",
            issued.data.pat.shortId
          )
        );
        expect(yield* native(() => list.json())).toEqual({
          data: {
            pats: [
              {
                shortId: issued.data.pat.shortId,
                recipientLabel: "CLI",
                scopes: ["write"],
                createdAt: DateTime.formatIso(DateTime.makeUnsafe(dates[0].created_at_ms)),
                expiresAt: DateTime.formatIso(DateTime.makeUnsafe(dates[0].expires_at_ms)),
                lastUsedAt: null,
              },
            ],
          },
          next: [],
        });
        const path = "/pats/" + issued.data.pat.shortId;
        const foreign = yield* browser(path, bob, { method: "DELETE" });
        expect(foreign.status).toBe(404);
        yield* native(() => foreign.text());
        const activity = yield* browser(path + "/activity", alice, { method: "GET" });
        expect(activity.status).toBe(200);
        yield* native(() => activity.text());
        yield* owner.exec(
          "CREATE TRIGGER refuse_revocation_audit BEFORE INSERT ON audit_entries WHEN NEW.operation='pats.revokePAT' AND NEW.record_type='credential_call' BEGIN SELECT RAISE(IGNORE); END"
        );
        const failed = yield* browser(path, alice, { method: "DELETE" });
        expect(failed.status).toBe(503);
        yield* native(() => failed.text());
        expect(yield* owner.exec("SELECT revoked_at_ms FROM pats")).toEqual([
          { revoked_at_ms: null },
        ]);
        expect(
          yield* owner.exec(
            "SELECT count(*) AS n FROM consent_history WHERE record_type='pat_revocation'"
          )
        ).toEqual([{ n: 0 }]);
        yield* owner.exec("DROP TRIGGER refuse_revocation_audit");
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('initial',?,'processing_grant',?)",
          alice.user,
          owner.now
        );
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,grant_record_id,session_id,record_type,occurred_at_ms) SELECT '90000000-0000-4000-8000-000000000010',user_id,id,?,'processing_withdrawal',? FROM consent_history WHERE record_type='processing_grant'",
          alice.session,
          owner.now + 1
        );
        const withdrawn = yield* browser("/pats", alice, { method: "GET" });
        expect(withdrawn.status).toBe(401);
        yield* native(() => withdrawn.text());
        const revoke = yield* browser(path, alice, { method: "DELETE" });
        expect(revoke.status).toBe(200);
        yield* native(() => revoke.text());
        const revokeAll = yield* browser("/pats", alice, { method: "DELETE" });
        expect(revokeAll.status).toBe(200);
        yield* native(() => revokeAll.text());
        expect(
          yield* owner.exec(
            "SELECT operation FROM audit_entries WHERE record_type='credential_call' AND operation IN ('pats.listPATs','pats.getPATActivity','pats.revokePAT','pats.revokeAllPATs') ORDER BY operation"
          )
        ).toEqual(
          ["pats.getPATActivity", "pats.listPATs", "pats.revokeAllPATs", "pats.revokePAT"].map(
            (operation) => ({ operation })
          )
        );
        const denied = yield* native(() =>
          runtime.dispatchFetch("https://api.fidyapp.com/transactions", {
            method: "POST",
            headers: {
              "cf-connecting-ip": "192.0.2.35",
              authorization: "Bearer " + issued.data.bearer,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              money: { amount: "31.77", currency: "USD" },
              direction: "outflow",
              occurredAt: "2023-11-16T00:00:00.000Z",
            }),
          })
        );
        expect(denied.status).toBe(401);
        yield* native(() => denied.text());
      })
  );
  test.effect("rolls back a manual PAT batch when a later child is refused", () =>
    Effect.gen(function* () {
      const create = yield* nativeUserPlatform,
        runtime = yield* create(),
        owner = yield* seed(runtime, alice);
      const payload = {
        requestId: "816551ab-a25e-4167-b87c-f7cc68890078",
        grant: {
          recipientLabel: "CLI",
          scopes: ["read"],
          lifetimeDays: 7,
          reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(owner.now + 604800000)),
        },
      };
      const post = (calls: unknown[]): TransportResult =>
        native(() =>
          runtime.dispatchFetch("https://api.fidyapp.com/operations/atomic-batch", {
            method: "POST",
            headers: {
              origin: browserOrigins.production,
              cookie: "__Host-fidy_session=" + alice.bearer,
              "Fidy-Session-Binding": alice.session,
              "content-type": "application/json",
              "cf-connecting-ip": "192.0.2.35",
            },
            body: JSON.stringify({ calls }),
          })
        );
      const issue = {
        callId: "816551ab-a25e-4167-b87c-f7cc68890161",
        operation: "pats.createManualPAT",
        input: { payload },
      };
      const failed = yield* post([
        issue,
        {
          callId: "816551ab-a25e-4167-b87c-f7cc68890162",
          operation: "pats.approvePATPairing",
          input: { payload: { pairingId: "816551ab-a25e-4167-b87c-f7cc68890070" } },
        },
      ]);
      expect(failed.status).toBe(400);
      expect(yield* native(() => failed.json())).toMatchObject({ error: { failedCallIndex: 1 } });
      expect(yield* owner.exec("SELECT count(*) AS n FROM pats")).toEqual([{ n: 0 }]);
      const completed = yield* post([issue]);
      expect(completed.status).toBe(200);
      const reply = yield* native(() => completed.json());
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Schema.Struct({
            results: Schema.Tuple([
              Schema.Struct({
                output: Schema.Struct({ data: Schema.Struct({ bearer: Schema.String }) }),
              }),
            ]),
          }),
        })
      )(reply);
      expect(result.data.results[0].output.data.bearer).toMatch(/^fin_/u);
      const raw = result.data.results[0].output.data.bearer;
      expect(
        yield* owner.exec(
          "SELECT (SELECT count(*) FROM canonical_request_receipts WHERE instr(body,?)>0) + (SELECT count(*) FROM canonical_receipt_parts WHERE instr(part,?)>0) + (SELECT count(*) FROM agent_operation_receipt_bodies WHERE instr(body,?)>0) AS retained",
          raw,
          raw,
          raw
        )
      ).toEqual([{ retained: 0 }]);
      const replay = yield* post([issue]);
      expect(replay.status).toBe(400);
      expect(yield* native(() => replay.text())).not.toContain("fin_");
    })
  );
});
