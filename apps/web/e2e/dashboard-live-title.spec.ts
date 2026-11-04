import type { BrowserContext, Page, Route } from "@playwright/test";
import { type Cause, Effect, type Scope } from "effect";
import { playwright } from "./playwright-runtime";
import {
  createDashboardIfAbsent,
  openDashboardThroughCore,
  signInNavigationThroughCore,
} from "./real-core-fixture";

const { test, expect } = playwright;
const successStatus = 200;
const conflictStatus = 409;
const staleReadAgeMilliseconds = 6000;

test("persists the Dashboard title through the visible editor and browser reload", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationThroughCore({
          page,
          deferFreshEntry: true,
          request,
          identity: "navigationDashboard",
        })
      );
      yield* Effect.tryPromise(() => openDashboardThroughCore(page));
      yield* Effect.tryPromise(() => createDashboardIfAbsent(page));
      yield* Effect.tryPromise(() => expect(page.getByRole("heading", { level: 1 })).toBeVisible());
      const currentTitle = yield* Effect.tryPromise(() =>
        page.getByRole("heading", { level: 1 }).innerText()
      );
      const title =
        currentTitle === "Mis finanzas verificadas"
          ? "Mis finanzas verificadas otra vez"
          : "Mis finanzas verificadas";
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Personalizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Renombrar tablero" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Nuevo nombre del tablero").fill(`  ${title}  `)
      );
      const edited = page.waitForResponse(
        (response) =>
          response.url().endsWith("/dashboard/edits") && response.status() === successStatus
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar nombre del tablero" }).click()
      );
      expect((yield* Effect.tryPromise(() => edited)).status()).toBe(successStatus);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible()
      );
    })
  ));

const openTitleDraft = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Personalizar", exact: true }).click()
  );
  yield* Effect.tryPromise(() => page.getByRole("button", { name: "Renombrar tablero" }).click());
});
const failRefresh = (route: Route): Promise<void> => route.abort("failed");
const focusWindow = (): void => {
  window.dispatchEvent(new Event("visibilitychange"));
};
const preserveFailedDraft = Effect.fnUntraced(function* (page: Page) {
  const draft = "Borrador de otra pestaña";
  yield* Effect.tryPromise(() => page.getByLabel("Nuevo nombre del tablero").fill(draft));
  yield* Effect.tryPromise(() => page.clock.fastForward(staleReadAgeMilliseconds));
  yield* Effect.tryPromise(() => page.route("**/dashboard/view", failRefresh));
  const failed = page.waitForRequest((request) => request.url().endsWith("/dashboard/view"));
  yield* Effect.tryPromise(() => page.bringToFront());
  yield* Effect.tryPromise(() => page.evaluate(focusWindow));
  yield* Effect.tryPromise(() => failed);
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Reintentar actualización del tablero" })).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Nuevo nombre del tablero")).toHaveValue(draft)
  );
  yield* Effect.tryPromise(() => page.unroute("**/dashboard/view", failRefresh));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Reintentar actualización del tablero" }).click()
  );
  yield* Effect.tryPromise(() => expect(page.getByLabel("Nuevo nombre del tablero")).toBeEnabled());
});
const submitTitle = Effect.fnUntraced(function* (page: Page, status: number) {
  const result = page.waitForResponse(
    (reply) => reply.url().endsWith("/dashboard/edits") && reply.status() === status
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Guardar nombre del tablero" }).click()
  );
  yield* Effect.tryPromise(() => result);
});

const acquireTab = (
  context: BrowserContext
): Effect.Effect<Page, Cause.UnknownError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise(() => context.newPage()),
    (page) => Effect.tryPromise(() => page.close()).pipe(Effect.orDie)
  );

test("a stale title draft conflicts across tabs and survives a failed refresh", ({
  page,
  context,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationThroughCore({
          page,
          request,
          deferFreshEntry: true,
          identity: "navigationDashboard",
        })
      );
      yield* Effect.tryPromise(() => openDashboardThroughCore(page));
      yield* Effect.tryPromise(() => createDashboardIfAbsent(page));
      const second = yield* acquireTab(context);
      yield* Effect.tryPromise(() => second.clock.install());
      yield* Effect.tryPromise(() => openDashboardThroughCore(second));
      yield* openTitleDraft(page);
      yield* openTitleDraft(second);
      yield* preserveFailedDraft(second);
      yield* Effect.tryPromise(() =>
        page.getByLabel("Nuevo nombre del tablero").fill("Cambio de la primera pestaña")
      );
      yield* submitTitle(page, successStatus);
      yield* submitTitle(second, conflictStatus);
      yield* Effect.tryPromise(() =>
        expect(second.getByText("El tablero cambió en otra pestaña", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Cambio de la primera pestaña", exact: true })
        ).toBeVisible()
      );
    }).pipe(Effect.scoped)
  ));
