import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Clock, Effect, Schema } from "effect";
import {
  alice,
  nativeTransactionJourney,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

const RefusalBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String }),
  next: Schema.Array(Schema.Struct({ tool: Schema.String })),
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("advises only the recovery operations the calling credential can invoke", () =>
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const token = "fin_abcdefgh_" + "x".repeat(43);
      yield* seedNativePAT({
        db,
        userId: alice.user,
        token,
        scopes: ["write"],
        current: yield* Clock.currentTimeMillis,
      });
      const update = (headers: Record<string, string>): Promise<Response> =>
        db.send(
          new Request(
            "https://api.fidyapp.com/category-keyword-rules/10000000-0000-4000-8000-000000000077",
            {
              method: "PUT",
              headers: {
                "content-type": "application/json",
                origin: "https://app.fidyapp.com",
                ...headers,
              },
              body: JSON.stringify({
                keyword: "suggestion",
                categoryId: "10000000-0000-4000-8000-000000000002",
              }),
            }
          )
        );
      const denied = yield* native(() => update({ authorization: "Bearer " + token }));
      expect(denied.status).toBe(404);
      const denial = yield* Schema.decodeUnknownEffect(RefusalBody)(
        yield* native(() => denied.json())
      );
      expect(denial.next).toEqual([]);
      const advised = yield* native(() =>
        update({
          cookie: "__Host-fidy_session=" + alice.bearer,
          "Fidy-Session-Binding": alice.session,
        })
      );
      expect(advised.status).toBe(404);
      const advice = yield* Schema.decodeUnknownEffect(RefusalBody)(
        yield* native(() => advised.json())
      );
      expect(advice.next).toEqual([{ tool: "categories.listKeywordRules" }]);
    })
  );
});
