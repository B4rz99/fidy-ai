import type { Locator, Page } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { reloadTransactionsThroughCore, signInPaginationThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
const expectHistory = expect.configure({ timeout: 15_000 });
const firstPageSize = 100;
const retainedRecords = 105;
const historyRows = (page: Page): Locator =>
  page.getByRole("button", { name: /^Ver transacción Registro paginado /u });
const expectHistoryCount = Effect.fn((page: Page, count: number) =>
  Effect.tryPromise(() => expectHistory(historyRows(page)).toHaveCount(count))
);
const loadContinuation = (page: Page): Promise<void> =>
  historyRows(page).last().scrollIntoViewIfNeeded();

test("real Core/D1 history persists correction and confirmed deletion on the next page", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInPaginationThroughCore({ page, request }));
      yield* expectHistoryCount(page, firstPageSize);
      yield* Effect.tryPromise(() => loadContinuation(page));
      yield* expectHistoryCount(page, retainedRecords);
      const names = yield* Effect.tryPromise(() => historyRows(page).allTextContents());
      expect(new Set(names).size).toBe(retainedRecords);
      const laterRecord = page.getByRole("button", {
        name: "Ver transacción Registro paginado 0",
        exact: true,
      });
      yield* Effect.tryPromise(() => laterRecord.click());
      yield* Effect.tryPromise(() => page.getByLabel("Monto · COP", { exact: true }).fill("2000"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => reloadTransactionsThroughCore(page));
      yield* expectHistoryCount(page, firstPageSize);
      yield* Effect.tryPromise(() => loadContinuation(page));
      yield* expectHistoryCount(page, retainedRecords);
      yield* Effect.tryPromise(() => laterRecord.click());
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Monto · COP", { exact: true })).toHaveValue("2000")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Eliminar transacción", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cancelar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(laterRecord).toBeVisible());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Eliminar transacción", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Eliminar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Transacción eliminada", { exact: true })).toBeVisible()
      );
      yield* expectHistoryCount(page, firstPageSize);
      yield* Effect.tryPromise(() => loadContinuation(page));
      yield* expectHistoryCount(page, retainedRecords - 1);
      yield* Effect.tryPromise(() => expect(laterRecord).toHaveCount(0));
      yield* Effect.tryPromise(() => reloadTransactionsThroughCore(page));
      yield* expectHistoryCount(page, firstPageSize);
      yield* Effect.tryPromise(() => loadContinuation(page));
      yield* expectHistoryCount(page, retainedRecords - 1);
      yield* Effect.tryPromise(() => expect(laterRecord).toHaveCount(0));
    })
  ));
