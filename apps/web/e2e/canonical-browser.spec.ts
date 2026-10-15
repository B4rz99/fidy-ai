import { type Cause, Effect } from "effect";
import { apiOrigin, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;

const wait = <A>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
test("an under-scoped Transactions query displays only generic failure copy", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const secret = "other-user-financial-content";
      yield* wait(installUser(page));
      yield* wait(
        page.route(`${apiOrigin}/categories`, (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: response([]) })
        )
      );
      yield* wait(
        page.route(new RegExp(`^${apiOrigin}/transactions\\?`, "u"), (route) =>
          route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "scope_missing", message: secret }, next: [] }),
          })
        )
      );
      yield* wait(page.goto("/app/transactions"));
      yield* wait(expect(page.getByText("No pudimos cargar tus transacciones")).toBeVisible());
      expect(yield* wait(page.locator("body").textContent())).not.toContain(secret);
    })
  ));
test("revoked session hides Transactions without showing an internal response body", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const secret = "internal-session-diagnostics";
      yield* wait(
        page.route(`${apiOrigin}/user`, (route) =>
          route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "unauthenticated", message: secret }, next: [] }),
          })
        )
      );
      yield* wait(page.goto("/app/transactions"));
      yield* wait(expect(page.getByText("No pudimos autorizar esta acción.")).toBeVisible());
      yield* wait(expect(page.getByText("No hay transacciones para mostrar")).toHaveCount(0));
      expect(yield* wait(page.locator("body").textContent())).not.toContain(secret);
    })
  ));
