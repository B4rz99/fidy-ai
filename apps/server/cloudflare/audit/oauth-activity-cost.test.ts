import { Clock, Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { prepareOAuthActivity, prepareOAuthActivityPage } from "../../src/shell/audit/operations";
import { liveSessionConditions } from "../../src/shell/web-session/operations";
import { observeRetentionCost } from "../d1-test-fixture";
import { approvedFixture, exchangeFixture, wait } from "../oauth-agents/oauth-ingress.test-fixture";

it("reads the latest three OAuth outcomes without scanning unrelated User history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      expect((yield* wait(exchangeFixture(fixture))).status).toBe(200);
      const session = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, user_id: Schema.String })
      )(yield* wait(fixture.db.prepare("SELECT id,user_id FROM web_sessions LIMIT 1").first()));
      const credential = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_id: Schema.String })
      )(
        yield* wait(
          fixture.db
            .prepare("SELECT access_id FROM oauth_credentials WHERE connection_id=? LIMIT 1")
            .bind(fixture.connectionId)
            .first()
        )
      );
      const current = yield* Clock.currentTimeMillis;
      const noise = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Int)))(
        Array.from({ length: 2000 }, (_, index) => index)
      );
      yield* wait(
        fixture.db
          .prepare(`INSERT INTO audit_entries(record_type,id,user_id,operation,outcome,occurred_at_ms)
            SELECT 'credential_call','unrelated-'||value,?,'categories.listCategories','accepted',?+1000+value FROM json_each(?)`)
          .bind(session.user_id, current, noise)
          .run()
      );
      yield* wait(
        fixture.db.batch(
          [0, 1, 2, 3].map((index) =>
            fixture.db
              .prepare(`INSERT INTO audit_entries(record_type,id,user_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms)
                VALUES('credential_call',?,?,?,?,?,?,?)`)
              .bind(
                `30000000-0000-4000-8000-00000000000${index}`,
                session.user_id,
                fixture.connectionId,
                credential.access_id,
                "categories.listCategories",
                "accepted",
                current + index
              )
          )
        )
      );
      const observed = observeRetentionCost(fixture.db);
      const prepared = prepareOAuthActivity({
        db: observed.database,
        userId: session.user_id,
        connectionId: fixture.connectionId,
        guard: liveSessionConditions({ session, current }),
      });
      const rows = yield* wait(observed.database.batch([...prepared.statements]));
      const activity = yield* prepared.decode(rows);
      expect(activity.map((entry) => entry.id)).toEqual([
        "30000000-0000-4000-8000-000000000003",
        "30000000-0000-4000-8000-000000000002",
        "30000000-0000-4000-8000-000000000001",
      ]);
      expect(observed.cost().rowsRead).toBeLessThan(50);
      expect(observed.cost().rowsWritten).toBe(0);
      const pageCost = observeRetentionCost(fixture.db);
      const page = prepareOAuthActivityPage({
        connections: {
          sql: "SELECT id,user_id FROM oauth_connections WHERE user_id=? AND id=? LIMIT 25",
          params: [session.user_id, fixture.connectionId],
        },
        guard: liveSessionConditions({ session, current }),
      });
      const pageRows = yield* wait(
        pageCost.database
          .prepare(page.statement.sql)
          .bind(...page.statement.params)
          .all()
      );
      const activities = yield* page.decode(pageRows.results);
      expect(activities.get(fixture.connectionId)).toEqual(activity);
      expect(pageCost.cost().rowsRead).toBeLessThan(50);
      expect(pageCost.cost().rowsWritten).toBe(0);
    })
  ));
