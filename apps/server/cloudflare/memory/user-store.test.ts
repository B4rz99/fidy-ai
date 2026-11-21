import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import {
  alice,
  bob,
  nativeBrowserWrite,
  nativeTransactionJourney,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "binds an ordinary retry to its inputs and original 24-hour lifetime under live PAT authority",
    () =>
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney,
          current = yield* Clock.currentTimeMillis;

        const token = "fin_memwrit1_" + "w".repeat(43);
        yield* seedNativePAT({ db, userId: alice.user, token, scopes: ["write"], current });

        const write = (text: string): Effect.Effect<Response> =>
          native(() =>
            db.send(
              new Request("https://api.fidyapp.com/memories", {
                method: "POST",
                headers: {
                  authorization: "Bearer " + token,
                  "content-type": "application/json",
                  "Fidy-Retry-Key": "ordinary-memory-retry",
                },
                body: JSON.stringify({ text }),
              })
            )
          );

        const first = yield* write("monthly");
        expect(first.status).toBe(201);
        const firstBody = yield* native(() => first.text());

        const receipts = (): Effect.Effect<Awaited<ReturnType<typeof db.exec>>> =>
          native(() =>
            db.exec(
              "SELECT accepted_at_ms FROM canonical_request_receipts WHERE operation='memory.remember'"
            )
          );

        const accepted = yield* receipts();
        expect(accepted).toHaveLength(1);
        const again = yield* write("monthly");
        expect(again.status).toBe(201);
        expect(yield* native(() => again.text())).toBe(firstBody);
        expect((yield* write("different")).status).toBe(400);
        expect(yield* receipts()).toEqual(accepted);

        const admissions = (): Effect.Effect<Awaited<ReturnType<typeof db.exec>>> =>
          native(() =>
            db.exec(
              "SELECT count(*) AS n FROM audit_entries WHERE record_type='request_admission' AND operation='memory.remember'"
            )
          );

        expect(yield* admissions()).toEqual([{ n: 1 }]);
        yield* native(() =>
          db.exec(
            "UPDATE canonical_request_receipts SET accepted_at_ms=? WHERE operation='memory.remember'",
            current - 86400000
          )
        );
        const next = yield* write("monthly");
        expect(next.status).toBe(201);
        expect(yield* native(() => next.text())).not.toBe(firstBody);
        expect(yield* admissions()).toEqual([{ n: 2 }]);
        yield* native(() =>
          db.exec("UPDATE pats SET revoked_at_ms=? WHERE short_id='memwrit1'", current)
        );
        expect((yield* write("monthly")).status).toBe(401);
        expect(yield* native(() => db.exec("SELECT count(*) AS n FROM memories"))).toEqual([
          { n: 2 },
        ]);
      })
  );
  test.effect(
    "rechecks PAT scope, expiry, revocation and processing Consent for every Memory call",
    () =>
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney,
          current = yield* Clock.currentTimeMillis;

        const reader = "fin_memread1_" + "r".repeat(43),
          writer = "fin_memwrit1_" + "w".repeat(43);

        yield* seedNativePAT({
          db,
          userId: alice.user,
          token: reader,
          scopes: ["read"],
          current: current - 86400000,
        });
        yield* seedNativePAT({ db, userId: alice.user, token: writer, scopes: ["write"], current });

        const send = (token: string, method: string, suffix = ""): Effect.Effect<Response> =>
          native(() =>
            db.send(
              new Request("https://api.fidyapp.com/memories" + suffix, {
                method,
                headers: { authorization: "Bearer " + token, "content-type": "application/json" },
                body: method === "POST" ? JSON.stringify({ text: "pat" }) : null,
              })
            )
          );

        expect((yield* send(writer, "POST")).status).toBe(201);
        const recalled = yield* send(reader, "GET");
        expect(recalled.status).toBe(200);
        expect(yield* native(() => recalled.json())).toMatchObject({ data: [{ text: "pat" }] });
        expect((yield* send(writer, "GET")).status).toBe(403);
        const rejected = yield* send(reader, "POST");
        expect(rejected.status).toBe(403);
        expect(yield* native(() => rejected.json())).toMatchObject({
          error: { code: "scope_missing" },
        });
        expect((yield* send(reader, "DELETE", "/" + bob.user)).status).toBe(403);
        expect(
          yield* native(() =>
            db.exec(
              "SELECT operation FROM audit_entries WHERE record_type='credential_call' AND outcome='accepted' ORDER BY operation"
            )
          )
        ).toEqual([{ operation: "memory.recall" }, { operation: "memory.remember" }]);
        expect(
          yield* native(() =>
            db.exec("SELECT count(*) AS n FROM pats WHERE last_used_at_ms IS NOT NULL")
          )
        ).toEqual([{ n: 2 }]);
        yield* native(() =>
          db.exec("UPDATE pats SET expires_at_ms=? WHERE short_id='memread1'", current - 1)
        );
        expect((yield* send(reader, "GET")).status).toBe(401);
        yield* native(() =>
          db.exec(
            "UPDATE pats SET expires_at_ms=?,revoked_at_ms=? WHERE short_id='memread1'",
            current + 86400000,
            current
          )
        );
        expect((yield* send(reader, "GET")).status).toBe(401);
        yield* native(() =>
          db.exec(
            "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES(?,?,'processing_grant',?)",
            bob.user,
            alice.user,
            current
          )
        );
        yield* native(() =>
          db.exec(
            "INSERT INTO consent_history(id,user_id,record_type,grant_record_id,session_id,occurred_at_ms) VALUES(?,?,'processing_withdrawal',?,?,?)",
            alice.user,
            alice.user,
            bob.user,
            alice.session,
            current
          )
        );
        expect((yield* send(writer, "POST")).status).toBe(403);
        expect(yield* native(() => db.exec("SELECT text FROM memories"))).toEqual([
          { text: "pat" },
        ]);
      })
  );
  test.effect(
    "retains normalized Memory from a mixed batch, scopes recall, and revises and forgets through ingress",
    () =>
      Effect.gen(function* () {
        const journey = yield* nativeTransactionJourney;

        const send = (
          user: typeof alice,
          path: string,
          options: { method: string } | { method: string; body: unknown }
        ): Effect.Effect<Response> => nativeBrowserWrite(journey)(user, { path, ...options });

        const created = yield* send(alice, "/operations/atomic-batch", {
          method: "POST",
          body: {
            calls: [
              {
                callId: alice.user,
                operation: "memory.remember",
                input: { payload: { text: "  monthly\r\nlimit  " } },
              },
              { callId: bob.user, operation: "dashboard.initializeDashboard", input: {} },
            ],
          },
        });

        expect(created.status).toBe(200);
        const reply = yield* native(() => journey.browser(0, "/memories"));
        const recalled = yield* native(() => reply.json());
        expect(recalled).toMatchObject({ data: [{ text: "monthly\nlimit" }] });

        const [row] = yield* native(() =>
          journey.exec("SELECT id FROM memories WHERE user_id=?", alice.user)
        );

        const path = "/memories/" + (yield* Schema.decodeUnknownEffect(Schema.String)(row?.id));
        expect((yield* send(bob, path, { method: "DELETE" })).status).toBe(404);
        expect(
          (yield* send(alice, path, { method: "PUT", body: { text: "new instruction" } })).status
        ).toBe(200);
        expect((yield* send(alice, path, { method: "DELETE" })).status).toBe(200);
        const final = yield* native(() => journey.browser(0, "/memories"));
        expect(yield* native(() => final.json())).toMatchObject({ data: [] });
      })
  );
});
