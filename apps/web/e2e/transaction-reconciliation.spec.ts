import type { Page, Route } from "@playwright/test";
import { type Cause, DateTime, Effect, Option } from "effect";
import { apiOrigin, installCategories, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const category = { id: "24000000-0000-4000-8000-000000000242", label: "Restaurantes" };
const now = DateTime.formatIso(Effect.runSync(DateTime.now));
const first = {
  id: "25000000-0000-4000-8000-000000000031",
  categoryId: category.id,
  money: { amount: "45000", currency: "COP" },
  counterparty: "El Corral",
  direction: "outflow",
  occurredAt: now,
  createdAt: now,
  revision: 0,
  notes: "Almuerzo registrado manualmente",
};
const second = {
  ...first,
  id: "25000000-0000-4000-8000-000000000032",
  notes: "Notificación recibida",
};
const restoredPairResponse = response({
  firstTransaction: { ...first, presentation: { kind: "independent" } },
  secondTransaction: { ...second, presentation: { kind: "independent" } },
});
const unlinkRefusal = JSON.stringify({
  error: { code: "validation_failed", message: "private detail", fields: [] },
  next: [],
});
type PairFixture = {
  linked: boolean;
  unlinks: number;
  deletions: number;
  readsFail: boolean;
  pending: Option.Option<Route>;
  inspectionChanged: boolean;
  deleteRefused: boolean;
};
const inspectedOriginal = (original: typeof first, changed: boolean): typeof first =>
  changed ? { ...original, money: { amount: "55000", currency: "COP" }, revision: 1 } : original;
const installOriginals = (page: Page, fixture: PairFixture): Promise<void> =>
  Promise.all(
    [first, second].map((original) =>
      page.route(`${apiOrigin}/transactions/${original.id}`, (route) => {
        if (route.request().method() === "DELETE") {
          fixture.deletions += 1;
          if (fixture.deleteRefused) {
            return route.fulfill({
              status: 400,
              contentType: "application/json",
              body: unlinkRefusal,
            });
          }
          return route.fulfill({
            contentType: "application/json",
            body: response(original.id),
          });
        }
        if (fixture.readsFail) return route.abort("failed");
        const freshFirst = inspectedOriginal(first, fixture.inspectionChanged);
        const freshSecond = inspectedOriginal(second, fixture.inspectionChanged);
        return route.fulfill({
          contentType: "application/json",
          body: response({
            ...(fixture.linked ? freshFirst : original),
            presentation: { kind: fixture.linked ? "visible-member" : "independent" },
            sources: fixture.linked
              ? [
                  { transactionId: first.id, kinds: ["manual"] },
                  { transactionId: second.id, kinds: ["notification-email"] },
                ]
              : [],
            reconciliation: fixture.linked
              ? { kind: "linked", firstTransaction: freshFirst, secondTransaction: freshSecond }
              : { kind: "independent" },
          }),
        });
      })
    )
  ).then(() => {});
const installPair = (
  page: Page,
  outcome: "success" | "uncertain" | "refused" | "pending" = "success",
  inspectionChanged = false
): Effect.Effect<PairFixture, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => installUser(page));
    yield* Effect.tryPromise(() => installCategories({ page, categories: [category] }));
    const fixture: PairFixture = {
      linked: true,
      unlinks: 0,
      deletions: 0,
      readsFail: false,
      pending: Option.none(),
      inspectionChanged,
      deleteRefused: false,
    };
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/transactions?*`, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: response(fixture.linked ? [first] : [first, second]),
        })
      )
    );
    yield* Effect.tryPromise(() => installOriginals(page, fixture));
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/transactions/unlink`, (route) => {
        fixture.unlinks += 1;
        expect(route.request().postDataJSON()).toEqual({
          firstTransactionId: first.id,
          secondTransactionId: second.id,
        });
        if (outcome === "refused") {
          return route.fulfill({
            status: 400,
            contentType: "application/json",
            body: unlinkRefusal,
          });
        }
        if (outcome === "pending") {
          fixture.pending = Option.some(route);
          return;
        }
        fixture.linked = false;
        if (outcome === "uncertain") return route.abort("failed");
        return route.fulfill({
          contentType: "application/json",
          body: restoredPairResponse,
        });
      })
    );
    yield* Effect.tryPromise(() => page.goto("/app/transactions"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: /^Ver transacción El Corral(?: Restaurantes)?$/u }).click()
    );
    return fixture;
  });

const pageOverflows = (): boolean => document.documentElement.scrollWidth > window.innerWidth;

test("reviews both originals, cancels without writing, and unlinks before a separate deletion confirmation on mobile", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
      const fixture = yield* installPair(page);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Ver vínculo", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText(first.notes, { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText(second.notes, { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Registro manual", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Correo de notificación", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.screenshot({
          path: test.info().outputPath("reconciliation-mobile.png"),
          fullPage: true,
        })
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cancelar", exact: true }).click()
      );
      expect(fixture.unlinks).toBe(0);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Eliminar transacción", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Revisar vínculo", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Desvincular", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Se desvincularon las transacciones", { exact: true })).toBeVisible()
      );
      expect(fixture.unlinks).toBe(1);
      expect(fixture.deletions).toBe(0);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Continuar eliminación", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Eliminar", exact: true })).toBeVisible()
      );
      expect(fixture.deletions).toBe(0);
      expect(yield* Effect.tryPromise(() => page.evaluate(pageOverflows))).toBe(false);
    })
  ));

const verifyFailedRecovery = (
  page: Page,
  fixture: PairFixture
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    fixture.readsFail = true;
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Actualizar estado", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByText("No pudimos confirmar el resultado", { exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Cerrar detalle", exact: true })).toBeDisabled()
    );
    expect(fixture.unlinks).toBe(1);
  });

for (const outcome of ["uncertain", "refused"] as const) {
  test(`${outcome} unlink requires an explicit successful read and never replays the mutation`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* installPair(page, outcome);
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Ver vínculo", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Desvincular", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(
            page.getByText(
              outcome === "uncertain"
                ? "No pudimos confirmar el resultado"
                : "No se pudo desvincular",
              { exact: true }
            )
          ).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Cerrar detalle", exact: true })).toBeDisabled()
        );
        yield* Effect.tryPromise(() => page.keyboard.press("Escape"));
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Actualizar estado", exact: true })).toBeVisible()
        );
        yield* verifyFailedRecovery(page, fixture);
        fixture.readsFail = false;
        fixture.linked = false;
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Actualizar estado", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText("El vínculo ya no está activo", { exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Se desvincularon las transacciones", { exact: true })).toHaveCount(
            0
          )
        );
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Ver en el historial", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(
            page.getByRole("button", { name: /^Ver transacción El Corral(?: Restaurantes)?$/u })
          ).toHaveCount(2)
        );
        expect(fixture.unlinks).toBe(1);
        expect(fixture.deletions).toBe(0);
        yield* Effect.tryPromise(() =>
          expect(page.getByText("private detail", { exact: true })).toHaveCount(0)
        );
      })
    ));
}

test("pending unlink locks dismissal and selection, then refreshes both originals after confirmed success", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme: "dark" }));
      const fixture = yield* installPair(page, "pending");
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Ver vínculo", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.screenshot({
          path: test.info().outputPath("reconciliation-grafito.png"),
          fullPage: true,
        })
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Desvincular", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Cerrar detalle", exact: true })).toBeDisabled()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Desvinculando transacciones…", exact: true })
        ).toBeDisabled()
      );
      yield* Effect.tryPromise(() => page.keyboard.press("Escape"));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: /^Ver transacción El Corral(?: Restaurantes)?$/u })
        ).toBeDisabled()
      );
      fixture.linked = false;
      const pending = Option.getOrThrow(fixture.pending);
      yield* Effect.tryPromise(() =>
        pending.fulfill({ contentType: "application/json", body: restoredPairResponse })
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Se desvincularon las transacciones", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cerrar detalle", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: /^Ver transacción El Corral(?: Restaurantes)?$/u })
        ).toHaveCount(2)
      );
      expect(fixture.unlinks).toBe(1);
    })
  ));

test("preserves deletion continuation after an uncertain unlink is read as independent", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* installPair(page, "uncertain");
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Eliminar transacción", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Revisar vínculo", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Desvincular", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar estado", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("El vínculo ya no está activo", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Continuar eliminación", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Eliminar", exact: true })).toBeEnabled()
      );
      expect(fixture.unlinks).toBe(1);
      expect(fixture.deletions).toBe(0);
    })
  ));

test("uses fresh inspection facts and requires history recovery before editing a changed revision", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* installPair(page, "success", true);
      const detail = page.getByRole("dialog", { name: "Detalle de transacción", exact: true });
      yield* Effect.tryPromise(() => expect(detail).toContainText("55.000,00"));
      yield* Effect.tryPromise(() => expect(detail).toContainText("La transacción cambió"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Guardar", exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Actualizar historial", exact: true })
        ).toBeVisible()
      );
    })
  ));

test("continued deletion offers direct review when another client relinks the pair", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* installPair(page);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Eliminar transacción", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Revisar vínculo", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Desvincular", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Continuar eliminación", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Eliminar", exact: true })).toBeEnabled()
      );
      fixture.linked = true;
      fixture.deleteRefused = true;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Eliminar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText(/No pudimos eliminar la transacción/u)).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Revisar vínculo", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Revisar vínculo", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Desvincular", exact: true })).toBeVisible()
      );
      expect(fixture.unlinks).toBe(1);
      expect(fixture.deletions).toBe(1);
    })
  ));
