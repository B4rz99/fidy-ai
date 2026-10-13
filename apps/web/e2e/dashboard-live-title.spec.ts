import { Effect } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { playwright } from "./playwright-runtime";
import { boundSessionRequests, signInThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const { api, app } = browserAcceptanceTopology();
const successStatus = 200;

test("renders the persisted Dashboard title after an admitted edit and browser reload", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      yield* Effect.tryPromise(() => expect(page.getByRole("heading", { level: 1 })).toBeVisible());
      const edited = yield* Effect.tryPromise(() =>
        boundSessionRequests(page.request).post(`${api}/dashboard/edits`, {
          headers: { origin: app },
          data: { op: "set-title", title: "Mis finanzas verificadas" },
        })
      );
      expect(edited.status()).toBe(successStatus);
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { level: 1, name: "Mis finanzas verificadas", exact: true })
        ).toBeVisible()
      );
    })
  ));
