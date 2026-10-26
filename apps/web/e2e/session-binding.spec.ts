import { ResourceLimited } from "@fidy/server/client";
import type { Page } from "@playwright/test";
import { Effect, Schema } from "effect";
import { apiOrigin } from "./http-fixtures";
import {
  probeCanonicalRequest,
  signInDashboardThroughCore,
  signInThroughCore,
} from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const unauthorizedStatus = 401;
const okStatus = 200;
const Binding = Schema.Struct({ binding: Schema.String });

const disableBroadcastChannel = (): void => {
  Object.defineProperty(window, "BroadcastChannel", { value: undefined });
};
const resourceLimitedStatus = 429;
const exhaustCanonicalBurst = Effect.fn(function* (other: Page, binding: string) {
  let sawResourceRefusal = false;
  const maximumBurstProbes = 20;
  for (let attempt = 0; attempt < maximumBurstProbes; attempt++) {
    const response = yield* Effect.tryPromise(() =>
      other.request.get(`${apiOrigin}/transactions`, {
        headers: {
          origin: new URL(other.url()).origin,
          "Fidy-Session-Binding": binding,
        },
      })
    );
    if (response.status() === resourceLimitedStatus) {
      yield* Schema.decodeUnknownEffect(Schema.toCodecJson(ResourceLimited))(
        yield* Effect.tryPromise(() => response.json())
      );
      sawResourceRefusal = true;
      break;
    }
    expect(response.status()).toBe(okStatus);
  }
  expect(sawResourceRefusal).toBe(true);
});
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
  const transactions = yield* probeCanonicalRequest({
    request: other.request,
    send: () =>
      other.request.get(`${apiOrigin}/transactions`, {
        headers: { origin: new URL(other.url()).origin, "Fidy-Session-Binding": binding },
      }),
  });
  expect(transactions.status()).toBe(okStatus);
  expect(yield* Effect.tryPromise(() => transactions.text())).not.toContain(
    "Old session private draft"
  );
});

test("rejects stale cross-tab drafts and logout", ({ page, context, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
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
      yield* Effect.tryPromise(() => page.getByLabel("Monto · COP").fill("12345"));
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
        page.getByRole("button", { name: "Registrar", exact: true }).click()
      );
      expect((yield* Effect.tryPromise(() => mutation)).status()).toBe(unauthorizedStatus);
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Contraparte (opcional)")).not.toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Old session private draft", { exact: true })).not.toBeVisible()
      );
      const logout = yield* Effect.tryPromise(() =>
        page.request.post(`${apiOrigin}/web/session/logout`, {
          headers: { origin: new URL(page.url()).origin, "Fidy-Session-Binding": first.binding },
        })
      );
      expect(logout.status()).toBe(unauthorizedStatus);
      yield* exhaustCanonicalBurst(other, second.binding);
      yield* expectSessionUnchanged(other, second.binding);
    })
  ));

test("retires the old product workspace while keeping sign-in and Privacy access live", ({
  page,
  context,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInThroughCore({ page, request }));
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible({
          signal,
        })
      );
      yield* Effect.tryPromise((signal) =>
        page.getByRole("link", { name: "Presupuestos", exact: true }).click({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("heading", { name: "Presupuestos", exact: true })).toBeVisible({
          signal,
        })
      );
      const other = yield* Effect.tryPromise(() => context.newPage());
      yield* Effect.tryPromise(() => signInDashboardThroughCore({ page: other, request }));
      yield* Effect.tryPromise((signal) =>
        expect(other.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible({
          signal,
        })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByText("No pudimos autorizar esta acción.")).toBeVisible({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: "Abrir agente Fidy" })).toHaveCount(0, { signal })
      );
      yield* Effect.tryPromise((signal) =>
        page.getByRole("link", { name: "Revisar privacidad", exact: true }).click({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("heading", { name: "Privacidad", exact: true })).toBeVisible({
          signal,
        })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("link", { name: "obarboza@fidyapp.com" })).toBeVisible({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: "Abrir agente Fidy" })).toHaveCount(0, { signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(other.getByText("No pudimos autorizar esta acción.")).not.toBeVisible({ signal })
      );
    })
  ));
