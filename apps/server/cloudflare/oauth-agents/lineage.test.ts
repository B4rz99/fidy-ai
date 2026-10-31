import { afterAll, expect, it } from "vitest";
import { Data, Effect } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { makeOauthAgentsErasureStores } from "./runtime";

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new FixtureFailure({ cause }),
  });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const owner = "14460000-0000-4000-8000-000000000001";
const foreign = "14460000-0000-4000-8000-000000000002";
const request = "14460000-0000-4000-8000-000000000003";
it("preserves OAuth rotation lineage until scoped erasure and refuses foreign or repeated changes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() =>
        db.batch([
          ...[owner, foreign].map((id) =>
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
              )
              .bind(id)
          ),
          ...["grant", "foreign"].map((id, index) =>
            db
              .prepare(
                "INSERT INTO oauth_connections(id,request_id,user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms,refresh_allowed) VALUES(?,?,?,'client','Unverified','https://example.com/callback','https://api.fidyapp.com/mcp','[\"read\",\"write\"]',1,10000,1)"
              )
              .bind(id, id, index === 0 ? owner : foreign)
          ),
          ...[
            { id: "old", issued: 100 },
            { id: "next", issued: 200 },
            { id: "last", issued: 300 },
          ].map(({ id, issued }) =>
            db
              .prepare(
                "INSERT INTO oauth_credentials(kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES('refresh',?,'grant',?,randomblob(32),?,9000,'[\"read\"]')"
              )
              .bind(id, owner, issued)
          ),
          db.prepare(
            "UPDATE oauth_credentials SET consumed_at_ms=200,replacement_refresh_id='next' WHERE id='old'"
          ),
          db.prepare(
            "UPDATE oauth_credentials SET consumed_at_ms=300,replacement_refresh_id='last' WHERE id='next'"
          ),
          ...[
            { id: "foreign-old", issued: 100 },
            { id: "foreign-next", issued: 200 },
          ].map(({ id, issued }) =>
            db
              .prepare(
                "INSERT INTO oauth_credentials(kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES('refresh',?,'foreign',?,randomblob(32),?,9000,'[\"read\"]')"
              )
              .bind(id, foreign, issued)
          ),
          db.prepare(
            "UPDATE oauth_credentials SET consumed_at_ms=200,replacement_refresh_id='foreign-next' WHERE id='foreign-old'"
          ),
          db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES(?,?,1,'Draining')"
            )
            .bind(request, owner),
          db
            .prepare(
              "INSERT INTO erasure_steps(request_id,store_id) VALUES(?,'oauth_refresh_events')"
            )
            .bind(request),
        ])
      );
      for (const sql of [
        "UPDATE oauth_credentials SET replacement_refresh_id='last' WHERE id='old'",
        "UPDATE oauth_credentials SET consumed_at_ms=NULL WHERE id='old'",
        `UPDATE oauth_credentials SET user_id='${foreign}' WHERE id='old'`,
        "DELETE FROM oauth_credentials WHERE id='old'",
      ]) {
        yield* native(() => expect(db.prepare(sql).run()).rejects.toThrow());
      }
      yield* native(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO oauth_credentials(kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES('refresh','future','grant',?,randomblob(32),400,9000,'[\"read\"]')"
            )
            .bind(owner),
          db.prepare(
            "UPDATE oauth_credentials SET consumed_at_ms=400,replacement_refresh_id='future' WHERE id='last'"
          ),
        ])
      );
      const store = makeOauthAgentsErasureStores(db).find(
        (entry) => entry.id === "oauth_refresh_events"
      );
      if (store === undefined) throw Error("Missing lineage erasure projection");
      const scope = { userId: owner, reference: request };

      yield* native(() =>
        db.prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?").bind(request).run()
      );
      expect(
        (yield* Effect.result(store.remove({ userId: foreign, reference: request })))._tag
      ).toBe("Failure");
      expect(yield* store.remove(scope)).toBe(true);
      expect(yield* store.remove(scope)).toBe(true);
      expect(
        (yield* native(() =>
          db
            .prepare(
              "SELECT id,consumed_at_ms,replacement_refresh_id FROM oauth_credentials WHERE id IN('old','next','last') ORDER BY issued_at_ms"
            )
            .all()
        )).results
      ).toEqual([
        { id: "old", consumed_at_ms: 200, replacement_refresh_id: null },
        { id: "next", consumed_at_ms: 300, replacement_refresh_id: null },
        { id: "last", consumed_at_ms: 400, replacement_refresh_id: null },
      ]);
      expect(
        yield* native(() =>
          db
            .prepare(
              "SELECT consumed_at_ms,replacement_refresh_id FROM oauth_credentials WHERE id='foreign-old'"
            )
            .first()
        )
      ).toEqual({ consumed_at_ms: 200, replacement_refresh_id: "foreign-next" });
      expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
        []
      );
    })
  ));
