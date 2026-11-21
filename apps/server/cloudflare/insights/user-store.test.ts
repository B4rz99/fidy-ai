import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, DateTime, Effect, Schema } from "effect";
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
    "pages the oldest 64 pending Insights and withholds unaccountable refusal and query results",
    () =>
      Effect.gen(function* () {
        const journey = yield* nativeTransactionJourney;
        const now = yield* Clock.currentTimeMillis;
        yield* native(() =>
          journey.exec(
            `WITH RECURSIVE n(i) AS(VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<65), fixture AS(SELECT i,printf('22460000-0000-4000-8000-%012d',i) AS id,? - 100000+i AS at FROM n)
     INSERT INTO insight_events(user_id,id,schedule_id,revision,scheduled_ms,event_json) SELECT ?,id,?,1,at,json_object('id',id,'kind','manual-entry-reminder','scheduleId',?,'scheduleVersion',1,'serviceMarket','CO','locale','es-CO','timeZone','America/Bogota','scheduledAt',strftime('%Y-%m-%dT%H:%M:%fZ',at/1000.0,'unixepoch'),'moneyGroups',json('[]'),'lifecycleState','pending') FROM fixture`,
            now,
            alice.user,
            bob.session,
            bob.session
          )
        );
        const ids = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
        const list = yield* native(() => journey.browser(0, "/insights/pending"));
        const first = yield* Schema.decodeUnknownEffect(ids)(yield* native(() => list.json()));
        expect(first.data).toHaveLength(64);
        const url = new URL((list.headers.get("link") ?? "").split(">")[0]?.slice(1) ?? "");
        const last = yield* native(() => journey.browser(0, url.pathname + url.search));
        const tail = yield* Schema.decodeUnknownEffect(ids)(yield* native(() => last.json()));
        expect(tail.data).toEqual([{ id: "22460000-0000-4000-8000-000000000065" }]);
        expect(last.headers.get("link")).toBeNull();

        const denied = (): Effect.Effect<Response> =>
          nativeBrowserWrite(journey)(alice, {
            path: "/insights/" + bob.user + "/read",
            method: "POST",
          });

        expect((yield* denied()).status).toBe(404);
        yield* native(() =>
          journey.exec(
            "CREATE TRIGGER fail_insight_audit BEFORE INSERT ON audit_entries WHEN NEW.operation GLOB 'insights.*' BEGIN SELECT RAISE(ABORT,'fixture'); END"
          )
        );
        expect((yield* denied()).status).toBe(503);
        const withheld = yield* native(() => journey.browser(0, "/insights/pending"));
        expect(withheld.status).toBe(503);
        expect(yield* native(() => withheld.text())).not.toContain("manual-entry-reminder");
        expect(
          yield* native(() =>
            journey.exec(
              "SELECT count(*) AS n FROM audit_entries WHERE operation='insights.markInsightRead'"
            )
          )
        ).toEqual([{ n: 1 }]);
      })
  );
  test.effect(
    "moves an owned Insight forward, retaining the exact delivery evidence and original reminder revision",
    () =>
      Effect.gen(function* () {
        const journey = yield* nativeTransactionJourney;

        const send = (user: typeof alice, path: string, body?: unknown): Effect.Effect<Response> =>
          nativeBrowserWrite(journey)(user, { path, method: "POST", body });

        const initially = yield* native(() => journey.browser(0, "/insights/reminder"));
        expect(initially.status).toBe(200);
        expect(yield* native(() => initially.json())).toMatchObject({ data: null });

        const occurrence = alice.session,
          schedule = bob.session;

        const now = yield* Clock.currentTimeMillis;
        const next = DateTime.formatIso(DateTime.makeUnsafe(now + 86400000));

        const instructions = {
          id: schedule,
          version: 1,
          enabled: true,
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/Bogota",
          cadence: { kind: "daily" },
          timing: { hour: 18, minute: 0 },
          nextScheduledAt: next,
        };

        yield* native(() =>
          journey.exec(
            "INSERT INTO proactive_grants(user_id,kind,id,record_json) VALUES(?,'manual-entry-reminder',?,'{}')",
            alice.user,
            bob.user
          )
        );
        yield* native(() =>
          journey.exec(
            "INSERT INTO reminder_schedules(user_id,id,revision,snapshot_json,next_at_ms,grant_id) VALUES(?,?,1,?,?,?)",
            alice.user,
            schedule,
            JSON.stringify(instructions),
            now + 86400000,
            bob.user
          )
        );

        const event = {
          id: occurrence,
          kind: "manual-entry-reminder",
          scheduleId: schedule,
          scheduleVersion: 1,
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/Bogota",
          scheduledAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          moneyGroups: [],
          lifecycleState: "pending",
        };

        yield* native(() =>
          journey.exec(
            "INSERT INTO insight_events(user_id,id,schedule_id,revision,scheduled_ms,event_json) VALUES(?,?,?,1,?,?)",
            alice.user,
            occurrence,
            schedule,
            now,
            JSON.stringify(event)
          )
        );

        const evidence = {
          sentAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: "wamid.test",
        };

        expect((yield* send(bob, "/insights/" + occurrence + "/read")).status).toBe(404);
        const token = "fin_insread1_" + "i".repeat(43);
        yield* seedNativePAT({
          db: journey,
          userId: alice.user,
          token,
          scopes: ["read"],
          current: now,
        });

        const agent = (method: string, path: string, body?: unknown): Effect.Effect<Response> =>
          native(() =>
            journey.send(
              new Request("https://api.fidyapp.com" + path, {
                method,
                headers: { authorization: "Bearer " + token, "content-type": "application/json" },
                body: body === undefined ? null : JSON.stringify(body),
              })
            )
          );

        const listing = yield* agent("GET", "/insights/pending");
        expect(listing.status).toBe(200);
        expect(yield* native(() => listing.json())).toMatchObject({ data: [{ id: occurrence }] });
        expect((yield* agent("POST", "/insights/" + occurrence + "/read")).status).toBe(403);
        yield* native(() =>
          journey.exec("UPDATE pats SET revoked_at_ms=? WHERE short_id='insread1'", now)
        );
        expect(
          (yield* agent("POST", "/insights/" + occurrence + "/delivered", evidence)).status
        ).toBe(401);
        expect(
          yield* native(() =>
            journey.exec(
              "SELECT receipt_json,json_extract(event_json,'$.lifecycleState') AS state FROM insight_events"
            )
          )
        ).toEqual([{ receipt_json: null, state: "pending" }]);
        const delivered = yield* send(alice, "/insights/" + occurrence + "/delivered", evidence);
        expect(delivered.status).toBe(200);
        expect(yield* native(() => delivered.json())).toMatchObject({
          data: { insight: { lifecycleState: "delivered" }, deliveryAttempt: evidence },
        });
        const pending = yield* native(() => journey.browser(0, "/insights/pending"));
        expect(yield* native(() => pending.json())).toMatchObject({ data: [] });
        expect(
          (yield* send(alice, "/insights/" + occurrence + "/delivered", {
            ...evidence,
            providerMessageId: "wamid.other",
          })).status
        ).toBe(400);

        const changed = yield* send(alice, "/operations/atomic-batch", {
          calls: [
            {
              callId: alice.user,
              operation: "insights.markInsightRead",
              input: { params: { id: occurrence } },
            },
            {
              callId: bob.user,
              operation: "insights.updateReminderSchedule",
              input: {
                payload: {
                  expectedVersion: 1,
                  cadence: { kind: "daily" },
                  timing: { hour: 14, minute: 0 },
                  timeZone: "America/Bogota",
                },
              },
            },
          ],
        });

        expect(changed.status).toBe(200);
        const dismissed = yield* send(alice, "/insights/" + occurrence + "/dismissed");
        expect(dismissed.status).toBe(200);
        expect(yield* native(() => dismissed.json())).toMatchObject({
          data: { scheduleVersion: 1, lifecycleState: "dismissed" },
        });
        yield* Effect.sleep("350 millis");
        expect((yield* send(alice, "/insights/" + occurrence + "/dismissed")).status).toBe(400);
        expect(
          (yield* send(alice, "/insights/" + occurrence + "/delivered", evidence)).status
        ).toBe(400);
        expect((yield* send(alice, "/insights/" + occurrence + "/read")).status).toBe(400);
      })
  );
});
