import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { Budget } from "../../src/core/budgets/contract";
import {
  alice,
  bob,
  category,
  nativeTransactionJourney,
} from "../transactions/user-store.test-fixture";
import { native } from "../user-store.test-fixture";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "reads a freshly committed monthly Budget from its User store and isolates foreign edits",
    () =>
      Effect.gen(function* () {
        const journey = yield* nativeTransactionJourney;
        const call = (
          subject: typeof alice,
          path: string,
          ...args: [method: string, payload?: unknown]
        ): Effect.Effect<Response> =>
          native(() =>
            journey.send(
              new Request("https://api.fidyapp.com" + path, {
                method: args[0],
                headers: {
                  origin: "https://app.fidyapp.com",
                  cookie: "__Host-fidy_session=" + subject.bearer,
                  "Fidy-Session-Binding": subject.session,
                  "content-type": "application/json",
                },
                ...(args[1] === undefined ? {} : { body: JSON.stringify(args[1]) }),
              })
            )
          );
        const cap = { amount: "9007199254740993.15", currency: "USD" };
        const payload = { categoryId: category, cap, month: "2023-11", groupName: "Family" };
        const created = yield* call(alice, "/budgets", "POST", payload);
        expect(created.status).toBe(201);
        const { data } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(Budget) })
        )(yield* native(() => created.json()));
        expect((yield* call(bob, "/budgets/" + data.id, "PUT", payload)).status).toBe(404);
        const month = yield* call(
          alice,
          "/budget-status?timeZone=America%2FBogota&month=2023-11",
          "GET"
        );
        expect(month.status).toBe(200);
        expect(yield* native(() => month.json())).toMatchObject({
          data: {
            initialized: true,
            budgets: [{ id: data.id, cap }],
            statuses: [{ type: "under", remaining: cap }],
          },
        });
      })
  );
});
