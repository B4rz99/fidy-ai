import type { Locator, Page, Route } from "@playwright/test";
import { type Cause, Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { apiOrigin, response } from "./http-fixtures";
import { installSubscriptionFixture, offers, paidStanding } from "./subscription-visual-fixture";

const { test, expect } = playwright;
const cancellation = {
  cancelledAt: "2026-11-02T15:00:00Z",
  paidThrough: "2026-11-25T14:00:00Z",
  sourceCancellation: "detached",
};
const cancellationAlert = (page: Page): Locator =>
  page.getByRole("region", { name: "Renovaciones de la suscripción" }).getByRole("alert");
const openPaidSubscription = Effect.fnUntraced(function* (page: Page) {
  yield* installSubscriptionFixture(page, "paid");
  yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
});

const installRoute = (
  page: Page,
  url: string,
  handler: (route: Route) => Promise<void>
): Effect.Effect<void, Cause.UnknownError> => Effect.tryPromise(() => page.route(url, handler));
const confirmCancellation = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise((signal) =>
    page
      .getByRole("button", { name: "Cancelar renovaciones futuras", exact: true })
      .click({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    page.getByRole("button", { name: "Confirmar cancelación", exact: true }).click({ signal })
  );
});

const recoverOffers = Effect.fnUntraced(function* (page: Page) {
  yield* installRoute(page, `${apiOrigin}/subscription/offers`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: response(offers) })
  );
  yield* Effect.tryPromise((signal) =>
    page.getByRole("button", { name: "Reintentar carga", exact: true }).click({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("button", { name: "Reintentar carga", exact: true })).toHaveCount(0, {
      signal,
    })
  );
});

const expectUncertainCancellation = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise((signal) =>
    expect(cancellationAlert(page)).toContainText("No pudimos confirmar", { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(
      page.getByRole("button", { name: "Cancelar renovaciones futuras", exact: true })
    ).toBeDisabled({ signal })
  );
});

test("Subscription cancellation reviews consequences, permits backing out and submits once", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      let requests = 0;
      yield* openPaidSubscription(page);
      yield* installRoute(page, `${apiOrigin}/subscription/cancellation`, (route) => {
        requests++;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: response(cancellation),
        });
      });
      yield* Effect.tryPromise((signal) =>
        page
          .getByRole("button", { name: "Cancelar renovaciones futuras", exact: true })
          .click({ signal })
      );
      const review = page.getByRole("region", { name: "Revisar cancelación" });
      yield* Effect.tryPromise((signal) =>
        expect(review).toContainText("Conservarás el acceso", { signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(review).toContainText("fuente de pago", { signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(review).toContainText("historial de pagos", { signal })
      );
      yield* Effect.tryPromise((signal) =>
        page.getByRole("button", { name: "Conservar renovaciones" }).click({ signal })
      );
      yield* Effect.tryPromise((signal) => expect(review).toHaveCount(0, { signal }));
      expect(requests).toBe(0);
      yield* confirmCancellation(page);
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("region", { name: "Renovaciones canceladas" })).toContainText(
          "25 de noviembre de 2026",
          { signal }
        )
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: "Confirmar cancelación" })).toHaveCount(0, {
          signal,
        })
      );
      expect(requests).toBe(1);
    })
  ));

test("Subscription cancellation recovers a lost response, verifies provider detachment and survives reload", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* installSubscriptionFixture(page, "offers-unavailable");
      let requests = 0;
      let recorded = false;
      let sourceCancellation = "void-pending";
      yield* installRoute(page, `${apiOrigin}/subscription/status`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: response({
            ...paidStanding,
            cancellation: recorded ? { ...cancellation, sourceCancellation } : null,
          }),
        })
      );
      yield* installRoute(page, `${apiOrigin}/subscription/cancellation`, (route) => {
        requests++;
        recorded = true;
        return route.abort("failed");
      });
      yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
      yield* confirmCancellation(page);
      yield* expectUncertainCancellation(page);
      yield* recoverOffers(page);
      yield* expectUncertainCancellation(page);
      yield* Effect.tryPromise((signal) =>
        page.getByRole("button", { name: "Consultar cancelación", exact: true }).click({ signal })
      );
      const result = page.getByRole("region", { name: "Renovaciones canceladas" });
      yield* Effect.tryPromise((signal) =>
        expect(result).toContainText("sigue pendiente", { signal })
      );
      yield* Effect.tryPromise((signal) => page.reload({ signal }));
      yield* Effect.tryPromise((signal) =>
        expect(result).toContainText("sigue pendiente", { signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByRole("button", { name: "Cancelar renovaciones futuras", exact: true })
        ).toHaveCount(0, { signal })
      );
      sourceCancellation = "voided";
      yield* Effect.tryPromise((signal) =>
        page.getByRole("button", { name: "Consultar cancelación", exact: true }).click({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(result).toContainText("Wompi confirmó", { signal })
      );
      expect(requests).toBe(1);
      expect(observed.preparations).toEqual([]);
      expect(observed.submissions).toEqual([]);
      expect(observed.providerCalls).toEqual([]);
      expect(observed.unexpectedRequests).toEqual([]);
    })
  ));

test("Subscription cancellation refuses replay after failure until status is explicitly checked", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* openPaidSubscription(page);
      let requests = 0;
      yield* installRoute(page, `${apiOrigin}/subscription/cancellation`, (route) => {
        requests++;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "unavailable", message: "Temporarily unavailable" },
            next: [],
          }),
        });
      });
      yield* confirmCancellation(page);
      yield* expectUncertainCancellation(page);
      yield* Effect.tryPromise((signal) =>
        page.getByRole("button", { name: "Consultar cancelación", exact: true }).click({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByRole("button", { name: "Cancelar renovaciones futuras", exact: true })
        ).toBeEnabled({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(cancellationAlert(page)).toHaveCount(0, { signal })
      );
      yield* Effect.tryPromise((signal) =>
        page
          .getByRole("button", { name: "Cancelar renovaciones futuras", exact: true })
          .click({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("region", { name: "Revisar cancelación" })).toBeVisible({ signal })
      );
      expect(requests).toBe(1);
    })
  ));

test("Subscription cancellation explains unavailable standing and recovers through a status read", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* installSubscriptionFixture(page, "unavailable");
      yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
      const management = page.getByRole("region", { name: "Renovaciones de la suscripción" });
      yield* Effect.tryPromise((signal) =>
        expect(management).toContainText("No podemos verificar las renovaciones", { signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByRole("button", { name: "Cancelar renovaciones futuras", exact: true })
        ).toHaveCount(0, { signal })
      );
      yield* installRoute(page, `${apiOrigin}/subscription/status`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: response(paidStanding),
        })
      );
      yield* Effect.tryPromise((signal) =>
        page.getByRole("button", { name: "Consultar cancelación", exact: true }).click({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByRole("button", { name: "Cancelar renovaciones futuras", exact: true })
        ).toBeEnabled({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByRole("region", { name: "Estado de la suscripción", exact: true })
        ).toContainText("Tu acceso:", { signal })
      );
    })
  ));

test("Subscription cancellation explains why access without a paid Subscription is ineligible", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* installSubscriptionFixture(page);
      yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
      const management = page.getByRole("region", { name: "Renovaciones de la suscripción" });
      yield* Effect.tryPromise((signal) =>
        expect(management).toContainText("No tienes una suscripción pagada", { signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByRole("button", { name: "Cancelar renovaciones futuras", exact: true })
        ).toHaveCount(0, { signal })
      );
      expect(observed.unexpectedRequests).toEqual([]);
    })
  ));

test("Subscription cancellation restores keyboard focus when review is dismissed", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* openPaidSubscription(page);
      const trigger = page.getByRole("button", {
        name: "Cancelar renovaciones futuras",
        exact: true,
      });
      yield* Effect.tryPromise((signal) => trigger.focus({ signal }));
      yield* Effect.tryPromise((signal) => trigger.press("Enter", { signal }));
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("heading", { name: "¿Cancelar renovaciones futuras?" })).toBeFocused({
          signal,
        })
      );
      const back = page.getByRole("button", { name: "Conservar renovaciones", exact: true });
      yield* Effect.tryPromise((signal) => back.focus({ signal }));
      yield* Effect.tryPromise((signal) => back.press("Enter", { signal }));
      yield* Effect.tryPromise((signal) => expect(trigger).toBeFocused({ signal }));
    })
  ));
