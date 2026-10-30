import type { Locator, Page } from "@playwright/test";
import { type Cause, Effect } from "effect";
import { playwright } from "./playwright-runtime";
import {
  openUpgradeThroughCore,
  signInRecurringThroughCore,
  signInSubscriptionReflowThroughCore,
  signInThroughCore,
} from "./real-core-fixture";

const { test, expect } = playwright;
const narrowViewport = { width: 320, height: 800 };
const wait = Effect.tryPromise;
const enlargeText = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  wait(() =>
    page.evaluate(() => {
      document.documentElement.style.fontSize = "32px";
    })
  );
const expectReflow = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  wait(() =>
    expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
  );
const expectLabelInsideAction = (action: Locator): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const bounds = yield* wait(() =>
      action.evaluate((element) => {
        const text = document.createRange();
        text.selectNodeContents(element);
        const label = text.getBoundingClientRect();
        const button = element.getBoundingClientRect();
        return {
          left: label.left - button.left,
          right: button.right - label.right,
          top: label.top - button.top,
          bottom: button.bottom - label.bottom,
        };
      })
    );
    for (const inset of Object.values(bounds)) expect(inset).toBeGreaterThanOrEqual(-1);
  });

const settings = [
  { path: "/settings/account", action: "Crear un código nuevo" },
  { path: "/settings/access", action: "Revocar todos los agentes conectados" },
  { path: "/settings/privacy", action: "Consultar prueba" },
];
for (const screen of settings) {
  test(`${screen.path} keeps its action readable at 320px with doubled text`, ({ page, request }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* wait(() => signInThroughCore({ page, request }));
        yield* wait(() => page.setViewportSize(narrowViewport));
        yield* wait(() => page.goto(screen.path));
        const action = page.getByRole("button", { name: screen.action, exact: true });
        yield* wait(() => expect(action).toBeVisible());
        yield* enlargeText(page);
        yield* expectReflow(page);
        yield* expectLabelInsideAction(action);
      })
    ));
}

test("Upgrade keeps every payment choice and exact offer price reachable with doubled text", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => signInSubscriptionReflowThroughCore({ page, request }));
      yield* wait(() => page.setViewportSize(narrowViewport));
      yield* wait(() => openUpgradeThroughCore(page));
      const yearly = page.getByRole("button", { name: /anual/u });
      yield* wait(() => expect(yearly).toBeVisible());
      yield* enlargeText(page);
      yield* expectReflow(page);
      for (const method of ["Tarjeta", "Nequi", "DaviPlata"]) {
        yield* expectLabelInsideAction(page.getByRole("button", { name: method, exact: true }));
      }
      yield* expectLabelInsideAction(yearly);
      yield* wait(() => page.getByRole("button", { name: "Nequi", exact: true }).click());
      yield* wait(() => yearly.click());
      yield* wait(() =>
        page.getByRole("button", { name: "Continuar con Nequi", exact: true }).click()
      );
      yield* wait(() =>
        expect(page.getByRole("heading", { name: "Pagar con Nequi" })).toBeVisible()
      );
    })
  ));

test("the recurring create action grows around its label and opens the editor with doubled text", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => signInRecurringThroughCore({ page, request, identity: "recurring" }));
      yield* wait(() => page.setViewportSize(narrowViewport));
      yield* wait(() => page.goto("/app/recurring?month=2026-10"));
      const create = page.getByRole("button", { name: "Nuevo recurrente", exact: true });
      yield* wait(() => expect(create).toBeEnabled());
      yield* enlargeText(page);
      yield* expectReflow(page);
      yield* expectLabelInsideAction(create);
      yield* wait(() => create.click());
      yield* wait(() =>
        expect(page.getByRole("dialog", { name: "Nuevo recurrente", exact: true })).toBeVisible()
      );
    })
  ));
