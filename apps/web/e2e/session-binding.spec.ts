import type { Page } from "@playwright/test";
import { Effect, Schema } from "effect";
import { apiOrigin } from "./http-fixtures";
import { signInDashboardThroughCore, signInThroughCore } from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const unauthorizedStatus = 401;
const okStatus = 200;
const Binding = Schema.Struct({ binding: Schema.String });

const disableBroadcastChannel = (): void => {
  Object.defineProperty(window, "BroadcastChannel", { value: undefined });
};
const expectSessionUnchanged = Effect.fn(function* (other: Page, binding: string) {
  const afterLogout = yield* Effect.tryPromise(() =>
    other.request.get(`${apiOrigin}/web/session/binding`, {
      headers: { origin: new URL(other.url()).origin },
    })
  );
  expect(
    (yield* Schema.decodeUnknownEffect(Binding)(yield* Effect.tryPromise(() => afterLogout.json())))
      .binding
  ).toBe(binding);
  const transactions = yield* Effect.tryPromise(() =>
    other.request.get(`${apiOrigin}/transactions`, {
      headers: { origin: new URL(other.url()).origin, "Fidy-Session-Binding": binding },
    })
  );
  expect(transactions.status()).toBe(okStatus);
  expect(yield* Effect.tryPromise(() => transactions.text())).not.toContain(
    "Old session private draft"
  );
});

// This exercises real public ingress, shared HttpOnly cookies, and independently mounted app owners.
test("rejects stale cross-tab drafts and logout", ({ page, context, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      // A missed cross-tab notification must not defeat the server's immutable session binding.
      yield* Effect.tryPromise(() => page.addInitScript(disableBroadcastChannel));
      yield* Effect.tryPromise(() => signInThroughCore({ page, request }));
      const bootstrap = yield* Effect.tryPromise(() =>
        page.request.get(`${apiOrigin}/web/session/binding`, {
          headers: { origin: new URL(page.url()).origin },
        })
      );
      const first = yield* Schema.decodeUnknownEffect(Binding)(
        yield* Effect.tryPromise(() => bootstrap.json())
      );
      expect(first.binding).toBeTruthy();
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "+ Registrar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.getByLabel("Monto ($)").fill("12345"));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Contraparte (opcional)").fill("Old session private draft")
      );
      const other = yield* Effect.tryPromise(() => context.newPage());
      yield* Effect.tryPromise(() => signInDashboardThroughCore({ page: other, request }));
      const current = yield* Effect.tryPromise(() =>
        other.request.get(`${apiOrigin}/web/session/binding`, {
          headers: { origin: new URL(other.url()).origin },
        })
      );
      const second = yield* Schema.decodeUnknownEffect(Binding)(
        yield* Effect.tryPromise(() => current.json())
      );
      expect(second.binding).not.toBe(first.binding);
      const mutation = page.waitForResponse(
        (response) =>
          response.url() === `${apiOrigin}/transactions` && response.request().method() === "POST"
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Registrar transacción" }).click()
      );
      expect((yield* Effect.tryPromise(() => mutation)).status()).toBe(unauthorizedStatus);
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Contraparte (opcional)")).not.toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Old session private draft", { exact: true })).not.toBeVisible()
      );
      // A prior session cannot log out the newly selected User either.
      const logout = yield* Effect.tryPromise(() =>
        page.request.post(`${apiOrigin}/web/session/logout`, {
          headers: { origin: new URL(page.url()).origin, "Fidy-Session-Binding": first.binding },
        })
      );
      expect(logout.status()).toBe(unauthorizedStatus);
      yield* expectSessionUnchanged(other, second.binding);
    })
  ));

test("keeps the signing-in tab live while a broadcast retires the other tab", ({
  page,
  context,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInThroughCore({ page, request }));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
      );
      const other = yield* Effect.tryPromise(() => context.newPage());
      yield* Effect.tryPromise(() => signInDashboardThroughCore({ page: other, request }));
      yield* Effect.tryPromise(() =>
        expect(other.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Tu sesión venció. Inicia sesión de nuevo.")).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(other.getByText("Tu sesión venció. Inicia sesión de nuevo.")).not.toBeVisible()
      );
    })
  ));
