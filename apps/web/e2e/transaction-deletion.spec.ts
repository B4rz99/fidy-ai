import type { Page, Route } from "@playwright/test";
import { type Cause, DateTime, Effect, Option } from "effect";
import { apiOrigin, installCategories, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const category = { id: "24000000-0000-4000-8000-000000000242", label: "Restaurantes" };
const now = DateTime.formatIso(Effect.runSync(DateTime.now));
const transaction = {
  id: "25000000-0000-4000-8000-000000000001",
  categoryId: category.id,
  money: { amount: "25000", currency: "COP" },
  counterparty: "Café de prueba",
  direction: "outflow",
  occurredAt: now,
  createdAt: now,
  revision: 0,
};
type DeletionFixture = {
  deleted: boolean;
  requests: number;
  pending: Option.Option<Route>;
};
const pendingReceived =
  (fixture: DeletionFixture): (() => boolean) =>
  () =>
    Option.isSome(fixture.pending);
const installDeletion = (
  page: Page,
  outcome: "pending" | "rejected" | "uncertain"
): Effect.Effect<
  { fixture: DeletionFixture; transaction: typeof transaction },
  Cause.UnknownError
> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => installUser(page));
    yield* Effect.tryPromise(() => installCategories({ page, categories: [category] }));
    const fixture: DeletionFixture = { deleted: false, requests: 0, pending: Option.none() };
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/transactions?*`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: response(fixture.deleted ? [] : [transaction]),
        })
      )
    );
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/transactions/${transaction.id}`, (route) => {
        expect(route.request().method()).toBe("DELETE");
        fixture.requests += 1;
        if (outcome === "pending") {
          fixture.pending = Option.some(route);
          return;
        }
        if (outcome === "uncertain") {
          fixture.deleted = true;
          return route.abort("failed");
        }
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "validation_failed", message: "private-provider-detail", fields: [] },
            next: [],
          }),
        });
      })
    );
    yield* Effect.tryPromise(() => page.goto("/app/transactions"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Ver transacción Café de prueba", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Eliminar transacción", exact: true }).click()
    );
    return { fixture, transaction };
  });

test("mobile deletion waits for confirmation and locks the selected Transaction until completion", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
      const { fixture, transaction } = yield* installDeletion(page, "pending");
      expect(fixture.requests).toBe(0);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cancelar", exact: true }).click()
      );
      expect(fixture.requests).toBe(0);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Eliminar transacción", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Eliminar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Eliminando transacción…", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Eliminar", exact: true })).toBeDisabled()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Cerrar detalle", exact: true })).toBeDisabled()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled()
      );
      yield* Effect.tryPromise(() => expect.poll(pendingReceived(fixture)).toBe(true));
      fixture.deleted = true;
      const pending = Option.getOrThrow(fixture.pending);
      yield* Effect.tryPromise(() =>
        pending.fulfill({
          status: 200,
          contentType: "application/json",
          body: response(transaction.id),
        })
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Transacción eliminada", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No hay transacciones para mostrar", { exact: true })).toBeVisible()
      );
      expect(fixture.requests).toBe(1);
    })
  ));

for (const outcome of ["rejected", "uncertain"] as const) {
  test(`${outcome} deletion requires history refresh and never reports success or replays`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { fixture } = yield* installDeletion(page, outcome);
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Eliminar", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("alert")).toContainText(
            outcome === "uncertain"
              ? "No pudimos confirmar si se eliminó"
              : "primero debes desvincularlas"
          )
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Transacción eliminada", { exact: true })).toHaveCount(0)
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText("private-provider-detail")).toHaveCount(0)
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Eliminar", exact: true })).toHaveCount(0)
        );
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Actualizar transacciones", exact: true }).last().click()
        );
        if (outcome === "uncertain") {
          yield* Effect.tryPromise(() =>
            expect(
              page.getByText("No hay transacciones para mostrar", { exact: true })
            ).toBeVisible()
          );
        } else {
          yield* Effect.tryPromise(() =>
            expect(
              page.getByRole("button", { name: "Ver transacción Café de prueba", exact: true })
            ).toBeVisible()
          );
        }
        expect(fixture.requests).toBe(1);
      })
    ));
}
