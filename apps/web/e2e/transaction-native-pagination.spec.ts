import type { Locator, Page } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { signInPaginationThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
const firstPageSize = 100;
const retainedRecords = 105;
const historyRows = (page: Page): Locator =>
  page.getByRole("button", { name: /^Ver transacción Registro paginado /u });
const loadContinuation = (page: Page): Promise<void> =>
  historyRows(page).last().scrollIntoViewIfNeeded();

test("real Core/D1 history continues beyond 100 and persists a correction on the next page", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInPaginationThroughCore({ page, request }));
      yield* Effect.tryPromise(() => expect(historyRows(page)).toHaveCount(firstPageSize));
      yield* Effect.tryPromise(() => loadContinuation(page));
      yield* Effect.tryPromise(() => expect(historyRows(page)).toHaveCount(retainedRecords));
      const names = yield* Effect.tryPromise(() => historyRows(page).allTextContents());
      expect(new Set(names).size).toBe(retainedRecords);
      const laterRecord = page.getByRole("button", {
        name: "Ver transacción Registro paginado 0",
        exact: true,
      });
      yield* Effect.tryPromise(() => laterRecord.click());
      yield* Effect.tryPromise(() => page.getByLabel("Monto ($)", { exact: true }).fill("2000"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar cambios", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() => expect(historyRows(page)).toHaveCount(firstPageSize));
      yield* Effect.tryPromise(() => loadContinuation(page));
      yield* Effect.tryPromise(() => expect(historyRows(page)).toHaveCount(retainedRecords));
      yield* Effect.tryPromise(() => laterRecord.click());
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Monto ($)", { exact: true })).toHaveValue("2000")
      );
    })
  ));
