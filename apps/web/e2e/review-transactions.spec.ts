import type { Page, Route } from "@playwright/test";
import { type Cause, Effect } from "effect";
import { apiOrigin, installBoundUser, installCategories, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { test, expect } = playwright;
const reviewId = "24000000-0000-4000-8000-000000001655";
const transactionId = "25000000-0000-4000-8000-000000001655";
const categoryId = "24000000-0000-4000-8000-000000000242";
const transaction = {
  id: transactionId,
  categoryId,
  money: { amount: "25000", currency: "COP" },
  counterparty: "Mercado QA revisión",
  direction: "outflow",
  occurredAt: "2026-10-01T02:00:00Z",
  createdAt: "2026-11-02T12:00:00Z",
  revision: 1,
  presentation: { kind: "independent" },
};
const inspection = { ...transaction, reconciliation: { kind: "independent" }, sources: [] };
const review = {
  id: reviewId,
  source: "statement",
  timeZone: "America/Bogota",
  reason: "ambiguous-currency",
  status: "created",
  transactionId,
  revision: 1,
  createdAt: "2026-11-02T12:00:00Z",
  expiresAt: "2027-01-13T12:00:00Z",
};
const reviewRoute = (route: Route): Promise<void> => {
  const path = new URL(route.request().url()).pathname;
  let data: unknown = { pendingCount: 0, total: 1, items: [review] };
  if (path.endsWith("/material")) {
    data = { available: true, text: "Mercado QA revisión · COP 25.000", truncated: false };
  } else if (path.endsWith(reviewId)) {
    data = { item: review, revision: 1 };
  }
  return route.fulfill({ contentType: "application/json", body: response(data) });
};
const installHistory = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => installBoundUser(page));
    yield* Effect.tryPromise(() =>
      installCategories({ page, categories: [{ id: categoryId, label: "Mercado" }] })
    );
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/ingestion/review-workspace**`, reviewRoute)
    );
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/transactions/${transactionId}`, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: response(inspection),
        })
      )
    );
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/transactions?*`, (route) => {
        const from = new URL(route.request().url()).searchParams.get("from");
        return route.fulfill({
          contentType: "application/json",
          body: response(from?.startsWith("2026-09-01") === true ? [transaction] : []),
        });
      })
    );
  });

test("created review history opens its Transaction in the local month list without selecting it", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* installHistory(page);
      yield* Effect.tryPromise(() => page.goto("/app/needs-review?status=history"));
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Ver transacción", exact: true }).click()
      );
      const row = page.getByRole("button", {
        name: "Ver transacción Mercado QA revisión",
        exact: true,
      });
      yield* Effect.tryPromise(() => expect(row).toBeInViewport());
      yield* Effect.tryPromise(() => expect(row).toHaveAttribute("aria-expanded", "false"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Detalle de transacción" })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Monto", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Mes de transacciones", { exact: true })).toHaveValue("09")
      );
    })
  ));

const desktopWidth = 1440;
const phoneWidth = 390;
const identifierWidth = 12;
const installLaterPages = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const firstPage = Array.from({ length: 25 }, (_, index) => ({
      ...transaction,
      id: `25000000-0000-4000-8000-${String(index).padStart(identifierWidth, "0")}`,
      counterparty: `Otra transacción ${index}`,
      occurredAt: "2026-09-30T23:00:00Z",
    }));
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/transactions?*`, (route) => {
        const url = new URL(route.request().url());
        const next = [
          {
            tool: "transactions.listTransactions",
            hint: "Continue browsing your FinancialRecord.",
            args: {
              query: {
                from: url.searchParams.get("from"),
                to: url.searchParams.get("to"),
                cursor:
                  "2026-09-30T23:00:00.000Z|2026-11-02T12:00:00.000Z|25000000-0000-4000-8000-000000000024",
              },
            },
          },
        ];
        return route.fulfill({
          contentType: "application/json",
          body: url.searchParams.has("cursor")
            ? response([transaction])
            : JSON.stringify({ data: firstPage, next }),
        });
      })
    );
  });
const laterPageJourney = (page: Page, width: number): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.setViewportSize({ width, height: 850 }));
    yield* installHistory(page);
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/ingestion/review-workspace**`, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: response({
            pendingCount: 0,
            total: 1,
            items: [{ ...review, expiresAt: "2020-01-01T12:00:00Z" }],
          }),
        })
      )
    );
    yield* installLaterPages(page);
    yield* Effect.tryPromise(() => page.goto("/app/needs-review?status=history"));
    yield* Effect.tryPromise(() =>
      page.getByRole("link", { name: "Ver transacción", exact: true }).press("Enter")
    );
    const record = page.getByRole("button", {
      name: "Ver transacción Mercado QA revisión",
      exact: true,
    });
    yield* Effect.tryPromise(() => expect(record).toBeInViewport());
    yield* Effect.tryPromise(() => expect(record).toHaveAttribute("aria-expanded", "false"));
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCount(0));
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("button", { name: "Ver transacción Otra transacción 0", exact: true })
      ).toBeAttached()
    );
    yield* Effect.tryPromise(() => record.click());
    yield* Effect.tryPromise(() => expect(page.getByLabel("Monto", { exact: true })).toBeVisible());
  });
for (const width of [desktopWidth, phoneWidth]) {
  test(`history reveals a later-page Transaction without opening it at ${width}px, even after original expiry`, ({
    page,
  }) => Effect.runPromise(laterPageJourney(page, width)));
}

const unavailableJourney = (
  page: Page,
  missing: boolean
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* installHistory(page);
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/transactions/${transactionId}`, (route) =>
        missing
          ? route.fulfill({
              status: 404,
              contentType: "application/json",
              body: JSON.stringify({
                _tag: "NotFound",
                error: { code: "not_found", message: "Transaction not found." },
                next: [],
              }),
            })
          : route.abort("failed")
      )
    );
    yield* Effect.tryPromise(() => page.goto("/app/needs-review?status=history"));
    yield* Effect.tryPromise(() =>
      page.getByRole("link", { name: "Ver transacción", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("alert")).toContainText(
        missing ? "Transacción no disponible" : "No pudimos cargar la transacción"
      )
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: /Ver transacción Mercado/u })).toHaveCount(0)
    );
    if (missing) {
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Volver al historial" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("Creaste una transacción a partir de este elemento.", { exact: true })
        ).toBeVisible()
      );
    } else {
      yield* Effect.tryPromise(() => page.unroute(`${apiOrigin}/transactions/${transactionId}`));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/transactions/${transactionId}`, (route) =>
          route.fulfill({ contentType: "application/json", body: response(inspection) })
        )
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Reintentar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Ver transacción Mercado QA revisión", exact: true })
        ).toBeInViewport()
      );
    }
  });
for (const missing of [true, false]) {
  test(`review navigation handles ${missing ? "deleted or inaccessible records" : "temporary lookup failure with explicit retry"}`, ({
    page,
  }) => Effect.runPromise(unavailableJourney(page, missing)));
}

const emptyHistoryRoute = (route: Route): Promise<void> =>
  route.fulfill({ contentType: "application/json", body: response([]) });

test("a Transaction removed between lookup and list loading does not look successfully located", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* installHistory(page);
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/transactions?*`, emptyHistoryRoute));
      yield* Effect.tryPromise(() => page.goto("/app/needs-review?status=history"));
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Ver transacción", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("La transacción ya no aparece en este periodo.", { exact: true })
        ).toBeVisible()
      );
    })
  ));

const effectiveJourney = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* installHistory(page);
    const visible = {
      ...transaction,
      id: "25000000-0000-4000-8000-000000001656",
      occurredAt: "2026-08-01T12:00:00Z",
      presentation: { kind: "suppressed-member", requestedId: transactionId },
    };
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/transactions/${transactionId}`, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: response({
            ...visible,
            reconciliation: {
              kind: "linked",
              firstTransaction: transaction,
              secondTransaction: visible,
            },
            sources: [],
          }),
        })
      )
    );
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/transactions?*`, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: response(
            new URL(route.request().url()).searchParams.get("from")?.startsWith("2026-08-01") ===
              true
              ? [visible]
              : []
          ),
        })
      )
    );
    yield* Effect.tryPromise(() => page.goto("/app/needs-review?status=history"));
    yield* Effect.tryPromise(() =>
      page.getByRole("link", { name: "Ver transacción", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("button", { name: "Ver transacción Mercado QA revisión", exact: true })
      ).toBeInViewport()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Mes de transacciones", { exact: true })).toHaveValue("08")
    );
    yield* Effect.tryPromise(() => page.reload());
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("button", { name: "Ver transacción Mercado QA revisión", exact: true })
      ).toHaveAttribute("aria-expanded", "false")
    );
  });
test("review navigation resolves the current effective Transaction identity and date on entry and reload", ({
  page,
}) => Effect.runPromise(effectiveJourney(page)));
