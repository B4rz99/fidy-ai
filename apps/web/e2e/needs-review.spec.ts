import { captureVisualEvidence } from "./visual-evidence";
import { expectFinancialLabels } from "./financial-form-text";
import { signInNavigationPerformanceThroughCore, signInThroughCore } from "./real-core-fixture";
import type { Response as BrowserResponse, Page, Request, Route } from "@playwright/test";
import { DateTime, Effect, Schema } from "effect";
import { apiOrigin, installCategories, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { captureReviewEntryReplay, withReviewEntryEvidence } from "./review-entry-diagnostics";

const { expect, test } = playwright;
test.describe.configure({ mode: "parallel" });
const id = "24000000-0000-4000-8000-000000001350";
const item = {
  id,
  source: "statement",
  timeZone: "America/Bogota",
  reason: "ambiguous-currency",
  status: "pending",
  revision: 0,
  createdAt: "2026-10-15T12:00:00Z",
  expiresAt: "2027-01-13T12:00:00Z",
};

test("reviews an ingestion item alongside its original and saves a draft", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, reviewRoute)
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Por revisar", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Compra en Café — $13.500", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.getByLabel("Valor").fill("13500"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("status")).toContainText("Borrador guardado")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Confirmar", exact: true })).toBeDisabled()
      );
    })
  ));

test("saves an initial draft promptly and spaces continued autosaves", ({ page }) => {
  let writes = 0;
  const countWrites = (): number => writes;
  const settleInitial = 250;
  const settleContinued = 750;
  const clockTime = DateTime.nowUnsafe().epochMilliseconds;
  const save = (route: Route): Promise<void> => {
    if (!new URL(route.request().url()).pathname.endsWith("/edits")) return reviewRoute(route);
    writes++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response([
        {
          item: { ...item, revision: writes },
          revision: writes,
          draft: Schema.decodeUnknownSync(Schema.Struct({ draft: Schema.Unknown }))(
            route.request().postDataJSON()
          ).draft,
        },
      ]),
    });
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/ingestion/review-workspace**`, save));
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      const value = page.getByLabel("Valor", { exact: true });
      yield* Effect.tryPromise(() => expect(value).toBeVisible());
      yield* Effect.tryPromise(() => page.clock.install({ time: clockTime }));
      yield* Effect.tryPromise(() => page.clock.pauseAt(clockTime));
      yield* Effect.tryPromise(() => value.fill("13500"));
      yield* Effect.tryPromise(() => page.clock.runFor(settleInitial));
      yield* Effect.tryPromise(() => expect.poll(countWrites).toBe(1));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("status")).toContainText("Borrador guardado")
      );
      yield* Effect.tryPromise(() => value.fill("14500"));
      yield* Effect.tryPromise(() => page.clock.runFor(settleInitial));
      expect(writes).toBe(1);
      yield* Effect.tryPromise(() => page.clock.runFor(settleContinued));
      yield* Effect.tryPromise(() => expect.poll(countWrites).toBe(2));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("status")).toContainText("Borrador guardado")
      );
    })
  );
});

const reviewRoute = (route: Route): Promise<void> => {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith("/context")) {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response({ items: [{ id, reference: "Fila 1", expiresAt: item.expiresAt }] }),
    });
  }
  if (path.endsWith("/material")) {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response({
        available: true,
        text: "Compra en Café — $13.500",
        truncated: false,
      }),
    });
  }
  if (path.endsWith("/edits")) {
    const input = Schema.decodeUnknownSync(
      Schema.Struct({
        revision: Schema.Int,
        draft: Schema.optionalKey(Schema.Unknown),
      })
    )(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response([
        {
          item: { ...item, revision: input.revision + 1 },
          revision: input.revision + 1,
          draft: input.draft,
        },
      ]),
    });
  }
  if (path.endsWith(id)) {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response({ item, revision: 0 }),
    });
  }
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: response(
      new URL(route.request().url()).searchParams.get("status") === "history"
        ? { pendingCount: 1, total: 0, items: [] }
        : { pendingCount: 1, total: 1, items: [item] }
    ),
  });
};

const doubleInputText = (): void => {
  document.documentElement.style.fontSize = "32px";
};
const resetInputText = (): void => {
  document.documentElement.style.fontSize = "";
};
const mobileInputViewports = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 900, height: 844 },
];
const expectReviewReflow = (page: Page): Promise<void> =>
  expect.poll(() => page.evaluate(hasHorizontalOverflow)).toBe(false);

const captureReviewText = (page: Page): Promise<void> =>
  captureVisualEvidence({
    target: page.locator('[data-review="fields"]'),
    options: {
      path: test.info().outputPath("review-enlarged-dark.png"),
    },
  });

test("mobile review keeps editable financial text legible and enlarges it with text sizing", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, reviewRoute)
      );
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      const amount = page.getByLabel("Valor", { exact: true });
      const fields = [
        amount,
        page.getByLabel("Contraparte (opcional)", { exact: true }),
        page.getByRole("textbox", { name: "Buscar pendientes en esta página", exact: true }),
      ];
      yield* Effect.tryPromise(() => expect(amount).toBeVisible());
      const amountLabel = page.locator('label[for="review-amount"]');
      yield* Effect.tryPromise(() => expect(amountLabel).toHaveCSS("font-size", "14px"));
      for (const viewport of mobileInputViewports) {
        yield* Effect.tryPromise(() => page.setViewportSize(viewport));
        for (const field of fields) {
          yield* Effect.tryPromise(() => expect(field).toHaveCSS("font-size", "16px"));
        }
        expect(yield* Effect.tryPromise(() => page.evaluate(hasHorizontalOverflow))).toBe(false);
      }
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
      for (const field of fields) {
        yield* Effect.tryPromise(() => field.focus());
        yield* Effect.tryPromise(() => expect(field).toBeFocused());
      }
      yield* Effect.tryPromise(() => expect(amount).toHaveAttribute("inputmode", "decimal"));
      yield* Effect.tryPromise(() =>
        page.getByRole("combobox", { name: "Moneda", exact: true }).click()
      );
      const currencySearch = page.getByRole("combobox", { name: "Buscar: Moneda", exact: true });
      yield* Effect.tryPromise(() => expect(currencySearch).toHaveCSS("font-size", "16px"));
      yield* Effect.tryPromise(() => currencySearch.press("Escape"));
      yield* Effect.tryPromise(() => expect(currencySearch).toBeHidden());
      yield* Effect.tryPromise(() => page.evaluate(doubleInputText));
      yield* Effect.tryPromise(() => expect(amountLabel).toHaveCSS("font-size", "28px"));
      for (const field of fields) {
        yield* Effect.tryPromise(() => expect(field).toHaveCSS("font-size", "32px"));
      }
      yield* Effect.tryPromise(() => expectReviewReflow(page));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Activar tema oscuro", exact: true }).click()
      );
      for (const field of fields) {
        yield* Effect.tryPromise(() => expect(field).toHaveCSS("font-size", "32px"));
      }
      yield* Effect.tryPromise(() => captureReviewText(page));
      yield* Effect.tryPromise(() => page.evaluate(resetInputText));
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 1440, height: 900 }));
      yield* Effect.tryPromise(() => expect(amount).toHaveCSS("font-size", "12px"));
    })
  ));

test("does not open an unvisited editor when its inbox finishes after leaving Review", ({
  page,
  request,
}) => {
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const reads = { detail: 0, material: 0 };
  const detailReads = (): number => reads.detail;
  const materialReads = (): number => reads.material;
  const handler = (route: Route): Promise<void> => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/review-workspace") && url.searchParams.get("limit") !== "0") {
      requested.resolve();
      return release.promise.then(() => reviewRoute(route)).then(() => delivered.resolve());
    }
    if (url.pathname.endsWith("/material")) reads.material++;
    else if (url.pathname.endsWith(id)) reads.detail++;
    return reviewRoute(route);
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationPerformanceThroughCore({
          page,
          request,
          identity: "navigationReviewTransactions",
        })
      );
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, handler)
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => requested.promise);
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Transacciones", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
      );
      release.resolve();
      yield* Effect.tryPromise(() => delivered.promise);
      yield* Effect.tryPromise(() => page.waitForLoadState("networkidle"));
      expect(reads).toEqual({ detail: 0, material: 0 });
      yield* Effect.tryPromise(() =>
        page
          .getByRole("link", { name: /Por revisar/u })
          .first()
          .click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect.poll(detailReads).toBeGreaterThan(0));
      yield* Effect.tryPromise(() => expect.poll(materialReads).toBeGreaterThan(0));
    }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
  );
});

const reviewPageSize = 50;
const fixtureStart = 1350;
const uuidTailLength = 12;
const secondId = "24000000-0000-4000-8000-000000001351";
type Fixture = {
  id: string;
  revision: number;
  status: "pending" | "skipped" | "created";
  draft: unknown;
};
const editInput = Schema.Struct({
  _tag: Schema.Literals(["SaveDraft", "Create", "Skip", "Restore"]),
  id: Schema.optionalKey(Schema.String),
  draft: Schema.optionalKey(Schema.Unknown),
  items: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
});
const detailFixture = (entry: Fixture): unknown => ({
  item: {
    ...item,
    ...entry,
    ...(entry.status === "created"
      ? { transactionId: "24000000-0000-4000-8000-000000001352" }
      : {}),
  },
  revision: entry.revision,
  ...(entry.draft === undefined ? {} : { draft: entry.draft }),
});
const lifecycleRoute =
  (entries: Fixture[]) =>
  (route: Route): Promise<void> => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/material")) return reviewRoute(route);
    if (path.endsWith("/edits")) return saveFixture(route, entries);
    const entry = entries.find((candidate) => path.endsWith(candidate.id));
    if (entry !== undefined) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: response(detailFixture(entry)),
      });
    }
    return workspaceFixture(route, entries, url);
  };
const workspaceFixture = (route: Route, entries: Fixture[], url: URL): Promise<void> => {
  const filter = url.searchParams.get("status") ?? "pending";
  const visible = entries.filter((candidate) =>
    filter === "history" ? candidate.status !== "pending" : candidate.status === filter
  );
  if (url.pathname.endsWith("/context")) {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response({
        items: visible
          .slice(
            Number(url.searchParams.get("offset") ?? "0"),
            Number(url.searchParams.get("offset") ?? "0") + reviewPageSize
          )
          .map((entry) => ({
            id: entry.id,
            reference: `Fila ${entries.indexOf(entry) + 1}`,
            expiresAt: item.expiresAt,
          })),
      }),
    });
  }
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: response({
      pendingCount: entries.filter((candidate) => candidate.status === "pending").length,
      total: visible.length,
      items: visible
        .slice(
          Number(url.searchParams.get("offset") ?? "0"),
          Number(url.searchParams.get("offset") ?? "0") + reviewPageSize
        )
        .map((candidate) => ({
          ...item,
          ...candidate,
          ...(candidate.status === "created"
            ? { transactionId: "24000000-0000-4000-8000-000000001352" }
            : {}),
        })),
    }),
  });
};
const saveFixture = (route: Route, entries: Fixture[]): Promise<void> => {
  const input = Schema.decodeUnknownSync(editInput)(route.request().postDataJSON());
  const ids = input.items?.map((entry) => entry.id) ?? [input.id];
  const changed = entries.filter((entry) => ids.includes(entry.id));
  if (input._tag === "SaveDraft" && changed.some((entry) => entry.status !== "pending")) {
    return route.fulfill({
      status: 400,
      body: '{"error":{"code":"validation_failed","message":"Stale draft"}}',
    });
  }
  changed.forEach((entry) => mutateFixture(entry, input));
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: response(changed.map(detailFixture)),
  });
};

test("skips and restores in bulk, advances, and preserves edited drafts", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [id, secondId].map((value) => ({
        id: value,
        revision: 0,
        status: "pending",
        draft: undefined,
      }));
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => page.getByLabel("Valor", { exact: true }).fill("13500"));
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toHaveValue("13500")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Omitir", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("checkbox", { name: "Seleccionar Extracto Fila 1" })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("checkbox", { name: "Seleccionar Extracto Fila 2" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Deshacer omisión" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(2));
      yield* Effect.tryPromise(() =>
        page.getByRole("checkbox", { name: "Seleccionar Extracto Fila 1" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("checkbox", { name: "Seleccionar Extracto Fila 2" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Omitir 2 seleccionados" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Deshacer omisión" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(2));
    })
  ));

test("confirms creation with a toast and continues reviewing without leaving the workspace", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries = pagedReviewFixtures().slice(0, 2);
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Confirmar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.locator('[data-sonner-toast][data-type="success"]')).toHaveText(
          "Transacción creada"
        )
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/needs-review$/u));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("checkbox", { name: "Seleccionar Extracto Fila 1" })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("checkbox", { name: "Seleccionar Extracto Fila 2" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Historial", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Transacción creada", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("link", { name: "Ver transacción", exact: true })).toHaveAttribute(
          "href",
          "/app/transactions?transaction=24000000-0000-4000-8000-000000001352"
        )
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: /Pendientes/ }).click());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Confirmar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Todo al día", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/needs-review\?/u));
      expect(entries.filter((entry) => entry.status === "created")).toHaveLength(2);
    })
  ));

test("does not show creation success when the server cannot confirm the transaction", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries = pagedReviewFixtures().slice(0, 1);
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, unavailableCreationRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Confirmar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("No pudimos confirmar el guardado. Actualiza antes de continuar.")
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/needs-review$/u));
    })
  ));

const unavailableCreationRoute =
  (entries: Fixture[]) =>
  (route: Route): Promise<void> =>
    new URL(route.request().url()).pathname.endsWith("/edits")
      ? route.fulfill({
          status: 503,
          body: '{"error":{"code":"unavailable","message":"Try later"}}',
        })
      : lifecycleRoute(entries)(route);

test("rereads the saved draft after a lost acknowledgement on mobile", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [{ id, revision: 0, status: "pending", draft: undefined }];
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lostAcknowledgementRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => page.getByLabel("Valor", { exact: true }).fill("42000"));
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toBeDisabled()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar revisión" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toBeEnabled()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toHaveValue("42000")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Confirmar", exact: true })).toBeDisabled()
      );
      const overflow = yield* Effect.tryPromise(() => page.evaluate(hasHorizontalOverflow));
      expect(overflow).toBe(false);
    })
  ));

const lostAcknowledgementRoute =
  (entries: Fixture[]) =>
  (route: Route): Promise<void> => {
    if (route.request().url().endsWith("/edits")) {
      const input = Schema.decodeUnknownSync(editInput)(route.request().postDataJSON());
      const entry = entries[0];
      if (entry !== undefined) {
        entry.draft = input.draft;
        entry.revision += 1;
      }
      return route.abort("failed");
    }
    return lifecycleRoute(entries)(route);
  };

const hasHorizontalOverflow = (): boolean =>
  document.documentElement.scrollWidth > window.innerWidth;

test("flushes a just-edited draft before bulk skip and restores it", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [{ id, revision: 0, status: "pending", draft: undefined }];
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => page.getByRole("checkbox").click());
      yield* Effect.tryPromise(() => page.getByLabel("Valor", { exact: true }).fill("98765"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Omitir 1 seleccionado" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Deshacer omisión" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toHaveValue("98765")
      );
    })
  ));

const decisionReferences = [
  { id, revision: 0 },
  { id: secondId, revision: 0 },
];
const decisionFixtures = (): Fixture[] =>
  [id, secondId].map((value) => ({
    id: value,
    revision: 0,
    status: "pending",
    draft: undefined,
  }));

test("refuses an extra draft acknowledgement before submitting a review decision", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries = decisionFixtures();
      const writes: string[] = [];
      const route = (route: Route): Promise<void> => {
        if (!new URL(route.request().url()).pathname.endsWith("/edits")) {
          return lifecycleRoute(entries)(route);
        }
        const input = Schema.decodeUnknownSync(editInput)(route.request().postDataJSON());
        writes.push(input._tag);
        entries.forEach((entry) => mutateFixture(entry, input));
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: response(entries.map(detailFixture)),
        });
      };
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, route)
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => page.getByLabel("Valor", { exact: true }).fill("98765"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Omitir", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Actualizar revisión", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toBeDisabled()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Deshacer omisión" })).toHaveCount(0)
      );
      expect(writes).toEqual(["SaveDraft"]);
    })
  ));

type DecisionCorruption =
  | "duplicate"
  | "partial"
  | "extra"
  | "wrong status"
  | "stale revision"
  | "advanced revision";
const corruptDecision = (entries: Fixture[], corruption: DecisionCorruption): Fixture[] => {
  const first = entries[0];
  if (first === undefined) return [];
  switch (corruption) {
    case "duplicate":
      return [first, first];
    case "partial":
      return [first];
    case "extra":
      return [...entries, { ...first, id: "24000000-0000-4000-8000-000000001352" }];
    case "wrong status":
      return entries.map((entry) => ({ ...entry, status: "pending" }));
    case "stale revision":
      return entries.map((entry) => ({ ...entry, revision: 0 }));
    case "advanced revision":
      return entries.map((entry) => ({ ...entry, revision: 2 }));
  }
};
for (const corruption of [
  "duplicate",
  "partial",
  "extra",
  "wrong status",
  "stale revision",
  "advanced revision",
] as const) {
  test(`keeps the entire bulk review locked after ${corruption} decision results`, ({ page }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entries = decisionFixtures();
        const writes: unknown[] = [];
        const route = (route: Route): Promise<void> => {
          if (!new URL(route.request().url()).pathname.endsWith("/edits")) {
            return lifecycleRoute(entries)(route);
          }
          writes.push(route.request().postDataJSON());
          const input = Schema.decodeUnknownSync(editInput)(route.request().postDataJSON());
          entries.forEach((entry) => mutateFixture(entry, input));
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: response(corruptDecision(entries, corruption).map(detailFixture)),
          });
        };
        yield* Effect.tryPromise(() => installUser(page));
        yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
        yield* Effect.tryPromise(() =>
          page.route(`${apiOrigin}/ingestion/review-workspace**`, route)
        );
        yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
        yield* Effect.tryPromise(() => page.getByRole("checkbox").nth(0).check());
        yield* Effect.tryPromise(() => page.getByRole("checkbox").nth(1).check());
        const skip = page.getByRole("button", { name: "Omitir 2 seleccionados", exact: true });
        yield* Effect.tryPromise(() => skip.click());
        yield* Effect.tryPromise(() =>
          expect(
            page.getByText("No pudimos confirmar el cambio. Actualiza antes de continuar.", {
              exact: true,
            })
          ).toBeVisible()
        );
        yield* Effect.tryPromise(() => expect(skip).toBeDisabled());
        yield* Effect.tryPromise(() => expect(page.getByRole("checkbox").nth(0)).toBeChecked());
        yield* Effect.tryPromise(() => expect(page.getByRole("checkbox").nth(1)).toBeChecked());
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Deshacer omisión" })).toHaveCount(0)
        );
        expect(writes).toEqual([
          {
            _tag: "Skip",
            items: [
              { id, revision: 0 },
              { id: secondId, revision: 0 },
            ],
          },
        ]);
      })
    ));
}

test("retires Undo when a fresh observation has a newer review revision", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entry: Fixture = { id, revision: 0, status: "pending", draft: undefined };
      const entries = [entry];
      const writes: unknown[] = [];
      const route = (route: Route): Promise<void> => {
        if (new URL(route.request().url()).pathname.endsWith("/edits")) {
          writes.push(route.request().postDataJSON());
        }
        return lifecycleRoute(entries)(route);
      };
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, route)
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Omitir", exact: true }).click()
      );
      const undo = page.getByRole("button", { name: "Deshacer omisión", exact: true });
      yield* Effect.tryPromise(() => expect(undo).toBeEnabled());
      entry.status = "pending";
      entry.revision = 2;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(1));
      yield* Effect.tryPromise(() => expect(undo).toHaveCount(0));
      expect(writes).toEqual([{ _tag: "Skip", items: [{ id, revision: 0 }] }]);
    })
  ));

const committedLostBulkRoute =
  (entries: Fixture[], state: Readonly<{ failed: boolean }>, writes: unknown[]) =>
  (route: Route): Promise<void> => {
    if (!new URL(route.request().url()).pathname.endsWith("/edits")) {
      return workspaceRefreshRoute(entries, state)(route);
    }
    writes.push(route.request().postDataJSON());
    const input = Schema.decodeUnknownSync(editInput)(route.request().postDataJSON());
    entries.forEach((entry) => mutateFixture(entry, input));
    return route.abort("internetdisconnected");
  };
const concurrentDecisionRoute =
  (
    entries: Fixture[],
    writes: unknown[],
    gates: Readonly<{
      firstRequested: PromiseWithResolvers<void>;
      secondRequested: PromiseWithResolvers<void>;
      releaseFirst: PromiseWithResolvers<void>;
      releaseSecond: PromiseWithResolvers<void>;
    }>
  ) =>
  (route: Route): Promise<void> => {
    if (!new URL(route.request().url()).pathname.endsWith("/edits")) {
      return lifecycleRoute(entries)(route);
    }
    const input = Schema.decodeUnknownSync(editInput)(route.request().postDataJSON());
    writes.push(route.request().postDataJSON());
    const first = input.items?.[0]?.id === id;
    (first ? gates.firstRequested : gates.secondRequested).resolve();
    return (first ? gates.releaseFirst : gates.releaseSecond).promise.then(() =>
      saveFixture(route, entries)
    );
  };

test("keeps a lost bulk outcome locked through failed fresh recovery without replay", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries = decisionFixtures();
      const state = { failed: false };
      const writes: unknown[] = [];
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(
          `${apiOrigin}/ingestion/review-workspace**`,
          committedLostBulkRoute(entries, state, writes)
        )
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => page.getByRole("checkbox").nth(0).check());
      yield* Effect.tryPromise(() => page.getByRole("checkbox").nth(1).check());
      const skip = page.getByRole("button", { name: "Omitir 2 seleccionados", exact: true });
      yield* Effect.tryPromise(() => skip.click());
      const warning = page.getByText(
        "No pudimos confirmar el cambio. Actualiza antes de continuar.",
        { exact: true }
      );
      yield* Effect.tryPromise(() => expect(warning).toBeVisible());
      yield* Effect.tryPromise(() => expect(skip).toBeDisabled());
      state.failed = true;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText(
            "La información anterior puede estar desactualizada. Reintenta para consultar los datos actuales.",
            { exact: true }
          )
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(warning).toBeVisible());
      yield* Effect.tryPromise(() => expect(skip).toBeDisabled());
      expect(writes).toHaveLength(1);
      state.failed = false;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Reintentar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Todo al día", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(warning).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Deshacer omisión" })).toHaveCount(0)
      );
      expect(writes).toEqual([{ _tag: "Skip", items: decisionReferences }]);
    })
  ));

test("keeps another bulk scope locked when an individual review decision finishes", ({ page }) => {
  const firstRequested = Promise.withResolvers<void>();
  const secondRequested = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  return Effect.runPromise(
    Effect.gen(function* () {
      const entries = decisionFixtures();
      const writes: unknown[] = [];
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(
          `${apiOrigin}/ingestion/review-workspace**`,
          concurrentDecisionRoute(entries, writes, {
            firstRequested,
            secondRequested,
            releaseFirst,
            releaseSecond,
          })
        )
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Omitir", exact: true }).click()
      );
      yield* Effect.tryPromise(() => firstRequested.promise);
      yield* Effect.tryPromise(() =>
        page.getByRole("checkbox", { name: "Seleccionar Extracto Fila 2" }).check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Omitir 1 seleccionado", exact: true }).click()
      );
      yield* Effect.tryPromise(() => secondRequested.promise);
      releaseFirst.resolve();
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(1));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Omitir", exact: true })).toBeDisabled()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toBeDisabled()
      );
      expect(writes).toEqual([
        { _tag: "Skip", items: [{ id, revision: 0 }] },
        { _tag: "Skip", items: [{ id: secondId, revision: 0 }] },
      ]);
      releaseSecond.resolve();
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Todo al día", exact: true })).toBeVisible()
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseFirst.resolve();
          releaseSecond.resolve();
        })
      )
    )
  );
});

const heldDraftRoute =
  (
    entries: Fixture[],
    writes: unknown[],
    gate: Readonly<{ requested: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }>
  ) =>
  (route: Route): Promise<void> => {
    if (!new URL(route.request().url()).pathname.endsWith("/edits")) {
      return lifecycleRoute(entries)(route);
    }
    writes.push(route.request().postDataJSON());
    gate.requested.resolve();
    return gate.release.promise.then(() => saveFixture(route, entries));
  };
test("refuses the whole selected review set when a member expires during draft flush", ({
  page,
}) => {
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return Effect.runPromise(
    Effect.gen(function* () {
      const entries = decisionFixtures();
      const writes: unknown[] = [];
      const start = DateTime.toDateUtc(DateTime.makeUnsafe("2027-01-13T11:59:58Z"));
      yield* Effect.tryPromise(() => page.clock.install({ time: start }));
      yield* Effect.tryPromise(() => page.clock.pauseAt(start));
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(
          `${apiOrigin}/ingestion/review-workspace**`,
          heldDraftRoute(entries, writes, { requested, release })
        )
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Abrir Extracto Fila 2", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.getByRole("checkbox").nth(0).check());
      yield* Effect.tryPromise(() => page.getByRole("checkbox").nth(1).check());
      yield* Effect.tryPromise(() => page.getByLabel("Valor", { exact: true }).fill("98765"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Omitir 2 seleccionados", exact: true }).click()
      );
      yield* Effect.tryPromise(() => requested.promise);
      const afterOriginalExpiryMilliseconds = 3000;
      yield* Effect.tryPromise(() => page.clock.fastForward(afterOriginalExpiryMilliseconds));
      release.resolve();
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("No pudimos confirmar el cambio. Actualiza antes de continuar.", {
            exact: true,
          })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Omitir 2 seleccionados", exact: true })
        ).toBeDisabled()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Deshacer omisión" })).toHaveCount(0)
      );
      expect(writes).toEqual([
        expect.objectContaining({ _tag: "SaveDraft", id: secondId, revision: 0 }),
      ]);
    }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
  );
});

test("advances to a populated page and preserves navigation in the URL", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries = pagedReviewFixtures();
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review?status=pending&offset=50"));
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(1));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Confirmar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/offset=0/));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("checkbox")).toHaveCount(reviewPageSize)
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/status=pending/));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("checkbox")).toHaveCount(reviewPageSize)
      );
    })
  ));
const pagedReviewFixtures = (): Fixture[] =>
  Array.from({ length: 51 }, (_, index) => ({
    id: `24000000-0000-4000-8000-${String(fixtureStart + index).padStart(uuidTailLength, "0")}`,
    revision: 0,
    status: "pending",
    draft: {
      amount: "13500",
      currency: "COP",
      direction: "outflow",
      counterparty: "Cafe",
      occurredAt: "2026-01-01T12:00:00Z",
      userProvidedFields: [],
    },
  }));

const mutateFixture = (entry: Fixture, input: typeof editInput.Type): void => {
  entry.revision += 1;
  switch (input._tag) {
    case "SaveDraft":
      entry.draft = input.draft;
      break;
    case "Skip":
      entry.status = "skipped";
      break;
    case "Restore":
      entry.status = "pending";
      break;
    case "Create":
      entry.status = "created";
      break;
  }
};

test("requires an explicit currency for an ambiguous statement item", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [
        {
          id,
          revision: 0,
          status: "pending",
          draft: {
            amount: "13500",
            direction: "outflow",
            counterparty: "Cafe",
            occurredAt: "2026-01-01T12:00:00Z",
            userProvidedFields: [],
          },
        },
      ];
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Confirma la moneda de esta transacción")).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Confirmar", exact: true })).toBeDisabled()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("combobox", { name: "Moneda", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Buscar: Moneda", { exact: true }).fill("USD")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("option", { name: "USD", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Confirmar", exact: true })).toBeEnabled()
      );
    })
  ));

test("opens rows without bulk selection and keeps history discoverable", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [{ id, revision: 0, status: "pending", draft: undefined }];
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Abrir Extracto" }).click());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("checkbox", { name: "Seleccionar Extracto Fila 1" })
        ).not.toBeChecked()
      );
      yield* Effect.tryPromise(() => page.getByRole("checkbox").check());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Omitir 1 seleccionado" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Historial", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/status=history/));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Abrir Extracto" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Abrir Extracto" }).click());
      yield* Effect.tryPromise(() => page.getByRole("checkbox").check());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Restaurar 1 seleccionado" }).click()
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: /Pendientes/ }).click());
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(1));
    })
  ));

test("advances from a completed middle row and wraps after the last row", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const thirdId = "24000000-0000-4000-8000-000000001352";
      const entries: Fixture[] = [id, secondId, thirdId].map((value, index) => ({
        id: value,
        revision: 0,
        status: "pending",
        draft: {
          amount: "13500",
          currency: "COP",
          direction: "outflow",
          counterparty: `Contraparte ${index}`,
          occurredAt: "2026-01-01T12:00:00Z",
          userProvidedFields: [],
        },
      }));
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Abrir Extracto" }).nth(1).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Contraparte 1")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Confirmar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Contraparte 2")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Omitir", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Contraparte 0")
      );
    })
  ));

test("keeps the desktop review controls in the viewport with bulk selection", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [{ id, revision: 0, status: "pending", draft: undefined }];
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 1654, height: 978 }));
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => page.getByRole("checkbox").check());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Omitir 1 seleccionado" })).toBeInViewport({
          ratio: 1,
        })
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Confirmar", exact: true })).toBeInViewport({
          ratio: 1,
        })
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: /^Categoría:/u })).toBeInViewport({
          ratio: 1,
        })
      );
      const overflow = yield* Effect.tryPromise(() => page.evaluate(pageOverflow));
      expect(overflow).toBeLessThanOrEqual(1);
    })
  ));

const calendarDraft = {
  amount: "13500",
  currency: "COP",
  direction: "outflow",
  counterparty: "Café",
  occurredAt: "2026-01-01T17:30:00Z",
  userProvidedFields: [],
};

test("uses the shared calendar and preserves the local time when changing dates", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [
        {
          id,
          revision: 0,
          status: "pending",
          draft: calendarDraft,
        },
      ];
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Fecha del movimiento" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: /viernes, 2 de enero de 2026/ }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Hora del movimiento", exact: true })).toHaveText(
          "12:30"
        )
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("status").filter({ hasText: "Borrador guardado" })).toHaveCount(1)
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Fecha del movimiento" })).toHaveText(
          /2.*ene.*2026/u
        )
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Hora del movimiento", exact: true })).toHaveText(
          "12:30"
        )
      );
      yield* Effect.tryPromise(() => chooseReviewTime({ page, hour: "23", minute: "59" }));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("status").filter({ hasText: "Borrador guardado" })).toHaveCount(1)
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Hora del movimiento", exact: true })).toHaveText(
          "23:59"
        )
      );
    })
  ));

const pageOverflow = (): number => document.documentElement.scrollHeight - window.innerHeight;

test("switches between visited review tabs within 100ms without waiting for another request", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [
        { id, revision: 0, status: "pending", draft: undefined },
        { id: secondId, revision: 0, status: "skipped", draft: undefined },
      ];
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Historial", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Contraparte (opcional)").fill("Borrador entre vistas")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Historial", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Elemento omitido", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: /Pendientes/ }).click());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Completa la transacción", exact: true })
        ).toBeAttached()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Borrador entre vistas")
      );
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, delayedReviewRoute(entries))
      );
      yield* Effect.tryPromise(() => page.evaluate(measureHistorySwitch));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Historial", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Elemento omitido", exact: true })).toBeVisible({
          timeout: 100,
        })
      );
      yield* Effect.tryPromise(() => recordSwitchDuration(page));
      yield* Effect.tryPromise(() => page.getByRole("button", { name: /Pendientes/ }).click());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Completa la transacción", exact: true })
        ).toBeAttached({ timeout: 100 })
      );
    })
  ));

const delayedReviewRoute =
  (entries: Fixture[]) =>
  (route: Route): Promise<void> =>
    Effect.runPromise(
      Effect.sleep("1 second").pipe(
        Effect.andThen(Effect.tryPromise(() => lifecycleRoute(entries)(route)))
      )
    );

test("removes retained review fields and original material at the evidence deadline", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.clock.install({
          time: DateTime.toDateUtc(DateTime.makeUnsafe("2027-01-13T11:59:00Z")),
        })
      );
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, reviewRoute)
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => expect(page.getByLabel("Valor")).toBeVisible());
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Compra en Café — $13.500", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page
          .getByRole("navigation", { name: "Aplicación" })
          .getByText("Ajustes", { exact: true })
          .click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Cuenta", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Correo verificado", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.clock.fastForward("01:01"));
      yield* Effect.tryPromise(() => expect(page.getByLabel("Valor")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Compra en Café — $13.500", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => page.getByRole("link", { name: /^Por revisar/u }).click());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Este elemento venció", exact: true })
        ).toBeVisible()
      );
    })
  ));

const chooseReviewTime = ({
  page,
  hour,
  minute,
}: Readonly<{ page: Page; hour: string; minute: string }>): Promise<void> =>
  page
    .getByRole("button", { name: "Hora del movimiento", exact: true })
    .click()
    .then(() => page.getByRole("button", { name: /^Horas:/u }).click())
    .then(() => page.getByRole("menuitemradio", { name: hour, exact: true }).click())
    .then(() => page.getByRole("button", { name: /^Minutos:/u }).click())
    .then(() => page.getByRole("menuitemradio", { name: minute, exact: true }).click())
    .then(() => page.getByRole("button", { name: "Listo", exact: true }).click());

const measureHistorySwitch = (): void => {
  document.addEventListener(
    "click",
    function record(event): void {
      if (
        !(event.target instanceof Element) ||
        event.target.closest("button")?.textContent.trim() !== "Historial"
      ) {
        return;
      }
      document.removeEventListener("click", record, true);
      const start = performance.now();
      const check = (): void => {
        const heading = Array.from(document.querySelectorAll("h2")).find(
          (element) =>
            element.textContent === "Elemento omitido" && element.closest("[hidden]") === null
        );
        if (heading === undefined) {
          requestAnimationFrame(check);
          return;
        }
        document.body.dataset.reviewSwitchMilliseconds = String(performance.now() - start);
      };
      requestAnimationFrame(check);
    },
    true
  );
};

const recordSwitchDuration = (page: Page): Promise<void> =>
  expect(page.locator("body"))
    .toHaveAttribute("data-review-switch-milliseconds", /[0-9]/u)
    .then(() => page.locator("body").getAttribute("data-review-switch-milliseconds"))
    .then((milliseconds) => {
      expect(milliseconds).not.toBeNull();
      expect(Number(milliseconds)).toBeLessThan(100);
      return test.info().attach("review-switch-duration", {
        body: `${milliseconds} ms`,
        contentType: "text/plain",
      });
    });

for (const [destination, identity] of [
  ["Presupuestos", "navigationReviewBudget"],
  ["Transacciones", "navigationReviewTransactions"],
] as const) {
  const title = `returns from ${destination} with its review form and original already available`;
  test(title, ({ page, request }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          signInNavigationPerformanceThroughCore({ page, request, identity })
        );
        yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
        yield* Effect.tryPromise(() =>
          page.route(`${apiOrigin}/ingestion/review-workspace**`, reviewRoute)
        );
        yield* Effect.tryPromise(() =>
          page
            .getByRole("navigation", { name: "Aplicación" })
            .getByRole("link", { name: /^Por revisar/u })
            .click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Compra en Café — $13.500", { exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          page.getByLabel("Contraparte (opcional)").fill("Borrador al volver")
        );
        yield* Effect.tryPromise(() =>
          page.getByRole("link", { name: destination, exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("heading", { name: destination, exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          page.route(`${apiOrigin}/ingestion/review-workspace**`, delayedReviewRead)
        );
        yield* Effect.tryPromise(() => page.evaluate(measureReviewEntry));
        yield* Effect.tryPromise(() => page.getByRole("link", { name: /^Por revisar/u }).click());
        yield* Effect.tryPromise(() =>
          expect(page.getByLabel("Valor")).toBeVisible({ timeout: 100 })
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Compra en Café — $13.500", { exact: true })).toBeVisible({
            timeout: 100,
          })
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Borrador al volver")
        );
        yield* Effect.tryPromise(() =>
          expect(page.locator("body")).toHaveAttribute("data-review-entry-milliseconds", /[0-9]/u)
        );
        yield* recordReviewReturn(page, destination);
        if (destination === "Transacciones") {
          yield* verifyPrivacyDisposesReview(page);
        }
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Cerrar sesión", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Compra en Café — $13.500", { exact: true })).toHaveCount(0)
        );
      })
    )
  );
}

const verifyPrivacyDisposesReview = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise((signal) =>
    page
      .getByRole("navigation", { name: "Aplicación" })
      .getByText("Ajustes", { exact: true })
      .click({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    page.getByRole("link", { name: "Privacidad", exact: true }).click({ signal })
  );
  yield* Effect.tryPromise((signal) => expect(page).toHaveURL(/\/settings\/privacy$/u, { signal }));
  yield* Effect.tryPromise((signal) =>
    expect(page.getByText("Compra en Café — $13.500", { exact: true })).toHaveCount(0, { signal })
  );
  yield* Effect.tryPromise((signal) => expect(page.getByLabel("Valor")).toHaveCount(0, { signal }));
});

const delayedReviewRead = (route: Route): Promise<void> =>
  Effect.runPromise(
    Effect.sleep("1 second").pipe(Effect.andThen(Effect.tryPromise(() => reviewRoute(route))))
  );

const measureReviewEntry = (): void => {
  document.addEventListener(
    "click",
    () => {
      const started = performance.now();
      const observer = new MutationObserver(() => {
        const input = document.getElementById("review-amount");
        if (input === null || input.getClientRects().length === 0) return;
        document.body.dataset.reviewEntryMilliseconds = String(performance.now() - started);
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    },
    { capture: true, once: true }
  );
};

const reviewEntryTargetMilliseconds = 100;
const recordReviewEntry = (page: Page): Promise<void> =>
  page
    .locator("body")
    .getAttribute("data-review-entry-milliseconds")
    .then((milliseconds) => {
      expect(milliseconds).not.toBeNull();
      return page
        .locator('script[src="/@vite/client"]')
        .count()
        .then((development) => {
          if (development === 0) {
            expect(Number(milliseconds)).toBeLessThanOrEqual(reviewEntryTargetMilliseconds);
          }
          return test.info().attach("review-entry-duration", {
            body: `${milliseconds} ms`,
            contentType: "text/plain",
          });
        });
    });

const recordReviewReturn = Effect.fnUntraced(function* (
  page: Page,
  destination: "Presupuestos" | "Transacciones"
) {
  const measurement = Effect.tryPromise(() => recordReviewEntry(page));
  yield* destination === "Transacciones"
    ? withReviewEntryEvidence(
        measurement,
        captureReviewEntryReplay(page, test.info()).pipe(Effect.scoped)
      )
    : measurement;
});

test("refreshes a saved review draft from another device after returning", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entry: Fixture = { id, revision: 0, status: "pending", draft: undefined };
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute([entry]))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => expect(page.getByLabel("Valor")).toBeVisible());
      yield* Effect.tryPromise(() => openReviewSibling(page));
      entry.revision = 1;
      entry.draft = {
        amount: "49000",
        counterparty: "Borrador remoto",
        occurredAt: "",
        userProvidedFields: ["money", "counterparty"],
      };
      yield* Effect.tryPromise(() => page.getByRole("link", { name: /^Por revisar/u }).click());
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Borrador remoto")
      );
      yield* Effect.tryPromise(() => expect(page.getByLabel("Valor")).toHaveValue("49000"));
      const [saved] = yield* Effect.tryPromise(() =>
        Promise.all([
          page.waitForRequest(`${apiOrigin}/ingestion/review-workspace/edits`),
          page.getByLabel("Valor").fill("51000"),
        ])
      );
      expect(saved.postDataJSON()).toMatchObject({
        _tag: "SaveDraft",
        id,
        revision: 1,
        draft: { amount: "51000", counterparty: "Borrador remoto" },
      });
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("status")).toContainText("Borrador guardado")
      );
      yield* Effect.tryPromise(() => expect(page.getByLabel("Valor")).toHaveValue("51000"));
    })
  ));
const openReviewSibling = (page: Page): Promise<void> =>
  page
    .getByRole("navigation", { name: "Aplicación" })
    .getByText("Ajustes", { exact: true })
    .click()
    .then(() => page.getByRole("link", { name: "Cuenta", exact: true }).click())
    .then(() =>
      expect(page.getByRole("heading", { name: "Correo verificado", exact: true })).toBeVisible()
    );

const verifyHiddenReview = Effect.fnUntraced(function* (
  page: Page,
  popup: "dialog" | "listbox" | "menu"
) {
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole(popup, { includeHidden: true })).toHaveCount(0, { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("textbox", { name: "Contraparte (opcional)" })).toHaveCount(0, { signal })
  );
  yield* Effect.tryPromise(() => page.keyboard.press("Tab"));
  const hidden = yield* Effect.tryPromise((signal) =>
    page.locator("#review-amount").evaluate(
      (element) => ({
        rectangles: element.getClientRects().length,
        focused: element === document.activeElement,
      }),
      undefined,
      { signal }
    )
  );
  expect(hidden).toEqual({ rectangles: 0, focused: false });
});

const reviewPickers = [
  { label: "Fecha del movimiento", trigger: "button", popup: "dialog" },
  { label: "Hora del movimiento", trigger: "button", popup: "dialog" },
  { label: "Moneda", trigger: "combobox", popup: "listbox" },
  { label: "Categoría", trigger: "button", popup: "menu" },
  { label: "Tipo de transacción", trigger: "button", popup: "menu" },
] as const;
type ReviewPicker = (typeof reviewPickers)[number];
const checkPickerDismissal = Effect.fnUntraced(function* (page: Page, picker: ReviewPicker) {
  const pickerName = new RegExp(`^${RegExp.escape(picker.label)}(?:$|:)`, "u");
  yield* Effect.tryPromise(() =>
    page.getByRole("link", { name: "Recurrentes", exact: true }).click()
  );
  yield* Effect.tryPromise(() => page.getByRole("link", { name: /^Por revisar/u }).click());
  yield* Effect.tryPromise(() => page.getByRole(picker.trigger, { name: pickerName }).click());
  yield* Effect.tryPromise(() => expect(page.getByRole(picker.popup)).toBeVisible());
  yield* Effect.tryPromise(() => page.goBack());
  yield* verifyHiddenReview(page, picker.popup);
  yield* Effect.tryPromise(() => page.goForward());
  yield* Effect.tryPromise(() => expect(page.getByRole(picker.popup)).toHaveCount(0));
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Café")
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Historial", exact: true }).click()
  );
  yield* Effect.tryPromise(() => page.getByRole("button", { name: /^Pendientes/u }).click());
  yield* Effect.tryPromise(() => page.getByRole(picker.trigger, { name: pickerName }).click());
  yield* Effect.tryPromise(() => expect(page.getByRole(picker.popup)).toBeVisible());
  yield* Effect.tryPromise(() => page.goBack());
  yield* verifyHiddenReview(page, picker.popup);
  yield* Effect.tryPromise(() => page.goForward());
  yield* Effect.tryPromise(() => expect(page.getByRole(picker.popup)).toHaveCount(0));
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Café")
  );
});
const prepareReviewPickers = Effect.fnUntraced(function* (
  page: Page,
  request: Parameters<typeof signInThroughCore>[0]["request"]
) {
  yield* Effect.tryPromise(() => signInThroughCore({ page, deferFreshEntry: true, request }));
  yield* Effect.tryPromise(() => page.clock.resume());
  yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
  yield* Effect.tryPromise(() =>
    page.route(
      `${apiOrigin}/ingestion/review-workspace**`,
      lifecycleRoute([
        {
          id,
          revision: 0,
          status: "pending",
          draft: {
            amount: "13500",
            currency: "COP",
            direction: "outflow",
            counterparty: "Café",
            occurredAt: "2026-01-01T17:30:00Z",
            userProvidedFields: [],
          },
        },
      ])
    )
  );
  yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Café")
  );
});
test("dismisses every editor picker when leaving the retained review", ({ page, request }) =>
  Effect.runPromise(
    prepareReviewPickers(page, request).pipe(
      Effect.andThen(
        Effect.forEach(reviewPickers, (picker) => checkPickerDismissal(page, picker), {
          discard: true,
        })
      )
    )
  ));

test("preserves bulk selection when filtering and retains paging after no local matches", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = Array.from({ length: 51 }, (_, index) => ({
        id: `24000000-0000-4000-8000-${String(fixtureStart + index).padStart(uuidTailLength, "0")}`,
        revision: 0,
        status: "pending",
        draft: undefined,
      }));
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => page.getByRole("checkbox").first().check());
      yield* Effect.tryPromise(() =>
        page
          .getByRole("textbox", { name: "Buscar pendientes en esta página" })
          .fill("Sin coincidencia sintética")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Sin elementos en esta vista" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Siguiente", exact: true })).toBeEnabled()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("textbox", { name: "Buscar pendientes en esta página" }).fill("")
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox").first()).toBeChecked());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Filtrar por origen en esta página" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("menuitemradio", { name: "Imágenes", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Sin elementos en esta vista" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Siguiente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Limpiar selección y continuar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/offset=50/));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Anterior", exact: true })).toBeEnabled()
      );
    })
  ));

const bulkEditRequest = (page: Page): Promise<Request> =>
  page.waitForRequest((request) => request.url().endsWith("/edits") && request.method() === "POST");

test("bulk skip includes selected statements hidden by the source filter", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [id, secondId].map((value) => ({
        id: value,
        revision: 0,
        status: "pending",
        draft: undefined,
      }));
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        page.getByRole("checkbox", { name: "Seleccionar Extracto Fila 1" }).check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("checkbox", { name: "Seleccionar Extracto Fila 2" }).check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Filtrar por origen en esta página" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("menuitemradio", { name: "Imágenes", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("2 fuera de este filtro", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Revisar selección (2)", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Quitar Extracto Fila 1 de la selección", exact: true })
        ).toBeVisible()
      );
      const [request] = yield* Effect.all(
        [
          Effect.tryPromise(() => bulkEditRequest(page)),
          Effect.tryPromise(() =>
            page.getByRole("button", { name: "Omitir 2 seleccionados", exact: true }).click()
          ),
        ],
        { concurrency: "unbounded" }
      );
      expect(request.postDataJSON()).toEqual({
        _tag: "Skip",
        items: [
          { id, revision: 0 },
          { id: secondId, revision: 0 },
        ],
      });
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Deshacer omisión", exact: true })).toBeVisible()
      );
    })
  ));

test("changing review history status keeps selected rows until explicit discard", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [{ id, revision: 0, status: "skipped", draft: undefined }];
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Historial", exact: true }).click()
      );
      const checkbox = page.getByRole("checkbox", { name: "Seleccionar Extracto Fila 1" });
      yield* Effect.tryPromise(() => checkbox.check());
      const filter = page.getByRole("button", {
        name: "Mostrar historial: Historial",
        exact: true,
      });
      yield* Effect.tryPromise(() => filter.click());
      yield* Effect.tryPromise(() =>
        page.getByRole("menuitemradio", { name: "Omitidas", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Conservar selección", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(checkbox).toBeChecked());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", {
            name: "Filtrar por origen en esta página: Todos los orígenes",
            exact: true,
          })
        ).toBeFocused()
      );
      yield* Effect.tryPromise(() => filter.click());
      yield* Effect.tryPromise(() =>
        page.getByRole("menuitemradio", { name: "Omitidas", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Limpiar selección y continuar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/status=skipped/u));
      yield* Effect.tryPromise(() => expect(checkbox).not.toBeChecked());
    })
  ));

const workspaceRefreshRoute =
  (entries: Fixture[], state: Readonly<{ failed: boolean }>) =>
  (route: Route): Promise<void> =>
    state.failed && new URL(route.request().url()).pathname.endsWith("/review-workspace")
      ? route.abort("internetdisconnected")
      : lifecycleRoute(entries)(route);

test("recovers an empty inbox refresh without claiming it is current or inventing a change", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const state = { failed: false };
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, workspaceRefreshRoute([], state))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      const caughtUp = page.getByRole("heading", { name: "Todo al día", exact: true });
      yield* Effect.tryPromise(() => expect(caughtUp).toBeVisible());
      state.failed = true;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No pudimos cargar los elementos", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(caughtUp).not.toBeVisible());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("No pudimos confirmar el cambio. Actualiza antes de continuar.", {
            exact: true,
          })
        ).not.toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Restaurar 0 seleccionados", exact: true })
        ).not.toBeVisible()
      );
      state.failed = false;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Reintentar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(caughtUp).toBeVisible());
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No pudimos cargar los elementos", { exact: true })).not.toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Actualizar", exact: true })).toHaveCount(1)
      );
    })
  ));

const bulkRecoveryRoute =
  (entries: Fixture[], state: Readonly<{ failed: boolean }>) =>
  (route: Route): Promise<void> =>
    new URL(route.request().url()).pathname.endsWith("/edits")
      ? route.abort("internetdisconnected")
      : workspaceRefreshRoute(entries, state)(route);

test("retains stale review data and recovers an uncertain bulk decision through the offered retry", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [{ id, revision: 0, status: "pending", draft: calendarDraft }];
      const state = { failed: false };
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, bulkRecoveryRoute(entries, state))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      const amount = page.getByLabel("Valor", { exact: true });
      yield* Effect.tryPromise(() => expect(amount).toBeEnabled());
      state.failed = true;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar", exact: true }).click()
      );
      const stale = page.getByText(
        "La información anterior puede estar desactualizada. Reintenta para consultar los datos actuales.",
        { exact: true }
      );
      yield* Effect.tryPromise(() => expect(stale).toBeVisible());
      yield* Effect.tryPromise(() => expect(amount).toBeDisabled());
      const warning = page.getByText(
        "No pudimos confirmar el cambio. Actualiza antes de continuar.",
        { exact: true }
      );
      yield* Effect.tryPromise(() => expect(warning).not.toBeVisible());
      state.failed = false;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Reintentar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(amount).toBeEnabled());
      yield* Effect.tryPromise(() => expect(stale).not.toBeVisible());
      yield* Effect.tryPromise(() => page.getByRole("checkbox").click());
      const skip = page.getByRole("button", { name: "Omitir 1 seleccionado", exact: true });
      yield* Effect.tryPromise(() => skip.click());
      yield* Effect.tryPromise(() => expect(warning).toBeVisible());
      yield* Effect.tryPromise(() => expect(skip).toBeDisabled());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Actualizar", exact: true })).toHaveCount(1)
      );
      state.failed = true;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(stale).toBeVisible());
      yield* Effect.tryPromise(() => expect(warning).toBeVisible());
      yield* Effect.tryPromise(() => expect(skip).toBeDisabled());
      state.failed = false;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Reintentar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(stale).not.toBeVisible());
      yield* Effect.tryPromise(() => expect(warning).not.toBeVisible());
      yield* Effect.tryPromise(() => expect(skip).toBeEnabled());
    })
  ));

const materialRecoveryRoute =
  (state: Readonly<{ failed: boolean }>) =>
  (route: Route): Promise<void> =>
    route.fulfill(
      state.failed
        ? {
            status: 503,
            body: '{"error":{"code":"service_unavailable","message":"Synthetic read error"}}',
          }
        : {
            status: 200,
            contentType: "application/json",
            body: response({
              available: true,
              text: '<img src=x onerror="alert(1)"> Café',
              truncated: false,
            }),
          }
    );

test("recovers original reads without exposing markup or manual reprocessing on mobile", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [{ id, revision: 0, status: "pending", draft: calendarDraft }];
      const state = { failed: true };
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() =>
        page.route(
          `${apiOrigin}/ingestion/review-workspace/${id}/material`,
          materialRecoveryRoute(state)
        )
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No pudimos cargar el original.")).toBeVisible()
      );
      state.failed = false;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Reintentar original", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.locator("pre")).toHaveText('<img src=x onerror="alert(1)"> Café')
      );
      yield* Effect.tryPromise(() => expect(page.locator("pre img")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: /procesamiento|extracción/iu })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Fecha del movimiento" }).focus()
      );
      yield* Effect.tryPromise(() => page.keyboard.press("Enter"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("dialog", { name: "Seleccionar fecha" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.keyboard.press("Escape"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Fecha del movimiento" })).toBeFocused()
      );
    })
  ));

const unavailableStateRoute =
  (state: string) =>
  (route: Route): Promise<void> => {
    const path = new URL(route.request().url()).pathname;
    const target = state.startsWith("detail-") ? path.endsWith(id) : !path.endsWith("/material");
    if (!target) return reviewRoute(route);
    return state.endsWith("loading")
      ? Promise.resolve()
      : route.fulfill({
          status: 503,
          body: '{"error":{"code":"service_unavailable","message":"Synthetic read error"}}',
        });
  };
for (const [state, copy] of Object.entries({
  loading: "Cargando elementos",
  error: "No pudimos cargar los elementos",
  "detail-loading": "Cargando elemento",
  "detail-error": "No pudimos cargar todos los datos del elemento.",
})) {
  test(`preserves the approved review surface during ${state}`, ({ page }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => installUser(page));
        yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
        yield* Effect.tryPromise(() =>
          page.route(`${apiOrigin}/ingestion/review-workspace**`, unavailableStateRoute(state))
        );
        yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: /Pendientes/u })).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Historial", exact: true })).toBeVisible()
        );
        if (state.endsWith("loading")) {
          const loading = page.getByRole("status", { name: copy, exact: true });
          yield* Effect.tryPromise(() => expect(loading).toHaveAttribute("aria-busy", "true"));
          yield* Effect.tryPromise(() =>
            expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
          );
          yield* Effect.tryPromise(() => expect(loading).toContainText(copy));
          yield* Effect.tryPromise(() =>
            expect(
              page.getByRole("button", { name: "Crear transacción", exact: true })
            ).toHaveCount(0)
          );
        } else {
          yield* Effect.tryPromise(() => expect(page.getByText(copy).first()).toBeVisible());
        }
      })
    ));
}

test("distinguishes filtered history from an empty pending inbox when nothing is pending", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [{ id, revision: 0, status: "skipped", draft: calendarDraft }];
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review?status=history"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Elemento omitido", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page
          .getByRole("textbox", { name: "Buscar pendientes en esta página" })
          .fill("Sin coincidencia sintética")
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Sin elementos en esta vista", exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Todo al día", exact: true })).not.toBeVisible()
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: /Pendientes/u }).click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Todo al día", exact: true })).toBeVisible()
      );
    })
  ));

const reviewCardHeight = (element: Element): number => element.getBoundingClientRect().height;

test("keeps history geometry independent of selection retained in the hidden pending panel", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries: Fixture[] = [
        { id, revision: 0, status: "pending", draft: calendarDraft },
        { id: secondId, revision: 0, status: "skipped", draft: calendarDraft },
      ];
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 1654, height: 978 }));
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Historial", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Elemento omitido", exact: true })).toBeVisible()
      );
      const before = yield* Effect.tryPromise(() =>
        page.locator('[data-review="detail"]').filter({ visible: true }).evaluate(reviewCardHeight)
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: /Pendientes/u }).click());
      yield* Effect.tryPromise(() => page.getByRole("checkbox").first().check());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Omitir 1 seleccionado", exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Historial", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Elemento omitido", exact: true })).toBeVisible()
      );
      const after = yield* Effect.tryPromise(() =>
        page.locator('[data-review="detail"]').filter({ visible: true }).evaluate(reviewCardHeight)
      );
      expect(after).toBe(before);
    })
  ));

test("discards an unsent review draft when entering Privacy", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const start = DateTime.makeUnsafe("2026-10-28T12:00:00Z");
      yield* Effect.tryPromise(() => page.clock.install({ time: DateTime.toDateUtc(start) }));
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      let writes = 0;
      const countedRoute = (route: Route): Promise<void> => {
        if (route.request().method() === "POST") writes += 1;
        return reviewRoute(route);
      };
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, countedRoute)
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.clock.pauseAt(DateTime.toDateUtc(DateTime.add(start, { minutes: 1 })))
      );
      yield* Effect.tryPromise(() => page.getByLabel("Valor", { exact: true }).fill("98765"));
      yield* verifyPrivacyDisposesReview(page);
      const disposalObservationMilliseconds = 2000;
      yield* Effect.tryPromise(() => page.clock.runFor(disposalObservationMilliseconds));
      expect(writes).toBe(0);
    })
  ));

const compactDesktopWidth = 1280;
const wideDesktopWidth = 1440;
const releaseReviewRoute =
  (release: Promise<void>) =>
  (route: Route): Promise<void> =>
    release.then(() => reviewRoute(route));
for (const width of [compactDesktopWidth, wideDesktopWidth]) {
  test(`Review shows real content without placeholders at desktop width ${width}`, ({ page }) => {
    const release = Promise.withResolvers<void>();
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => page.setViewportSize({ width, height: 900 }));
        yield* Effect.tryPromise(() => installUser(page));
        yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
        yield* Effect.tryPromise(() =>
          page.route(
            `${apiOrigin}/ingestion/review-workspace**`,
            releaseReviewRoute(release.promise)
          )
        );
        yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
        yield* Effect.tryPromise(() =>
          expect(
            page.getByRole("status", { name: "Cargando elementos", exact: true })
          ).toHaveAttribute("aria-busy", "true")
        );

        yield* Effect.tryPromise(() =>
          expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
        );
        release.resolve();
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Confirmar", exact: true })).toBeVisible()
        );
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
    );
  });
}

const contextMobileWidth = 390;
const contextDesktopWidth = 1440;

const identifyIncompleteEntries = (count: number): Fixture[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `24000000-0000-4000-8000-${String(fixtureStart + index).padStart(uuidTailLength, "0")}`,
    revision: 0,
    status: "pending",
    draft: undefined,
  }));

for (const width of [contextMobileWidth, contextDesktopWidth]) {
  test(`identifies and searches incomplete originals without highlighting at ${width}px`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entries = identifyIncompleteEntries(reviewPageSize);
        yield* Effect.tryPromise(() => page.setViewportSize({ width, height: 900 }));
        yield* Effect.tryPromise(() => installUser(page));
        yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
        yield* Effect.tryPromise(() =>
          page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
        );
        yield* Effect.tryPromise(() =>
          page.route(
            `${apiOrigin}/ingestion/review-workspace/context**`,
            incompleteContextRoute(entries)
          )
        );
        yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
        const first = page.getByRole("checkbox", {
          name: "Seleccionar Extracto Fila 1",
          exact: true,
        });
        yield* Effect.tryPromise(() =>
          expect(first).toHaveAccessibleDescription(
            /Original sin confirmar: 2026-10-01,25000,Mercado/u
          )
        );
        yield* Effect.tryPromise(() =>
          expect(
            page.getByRole("checkbox", { name: "Seleccionar Extracto Fila 3", exact: true })
          ).toHaveAccessibleDescription(/Sin fragmento disponible/u)
        );
        yield* Effect.tryPromise(() =>
          expect(page.locator('[data-review="inbox"] img')).toHaveCount(0)
        );
        yield* Effect.tryPromise(() =>
          page.getByRole("textbox", { name: "Buscar pendientes en esta página" }).fill("Mercado")
        );
        yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(1));
        yield* Effect.tryPromise(() =>
          expect(page.getByText("2026-10-01,25000,Mercado", { exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() => expect(page.locator("mark")).toHaveCount(0));
        yield* Effect.tryPromise(() => first.check());
        yield* Effect.tryPromise(() => expect(first).toBeChecked());
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Abrir Extracto Fila 1", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByLabel("Valor", { exact: true })).toHaveValue("")
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText(/^Solo en esta página/u)).toBeVisible()
        );
      })
    ));
}

const incompleteContextRoute =
  (entries: ReadonlyArray<Fixture>) =>
  (route: Route): Promise<void> =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response({
        items: entries.map((entry, index) => ({
          id: entry.id,
          reference: `Fila ${index + 1}`,
          expiresAt: item.expiresAt,
          ...(index === 2
            ? {}
            : {
                excerpt:
                  index === 0
                    ? "2026-10-01,25000,Mercado"
                    : '2026-10-02,18000,Transporte <img src=x onerror="alert(1)">',
              }),
        })),
      }),
    });

test("removes expired source context from page search and accessible descriptions", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.clock.install({
          time: DateTime.toDateUtc(DateTime.makeUnsafe("2027-01-13T11:59:00Z")),
        })
      );
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, reviewRoute)
      );
      yield* Effect.tryPromise(() =>
        page.route(
          `${apiOrigin}/ingestion/review-workspace/context**`,
          incompleteContextRoute([{ id, revision: 0, status: "pending", draft: undefined }])
        )
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      const search = page.getByRole("textbox", { name: "Buscar pendientes en esta página" });
      const checkbox = page.getByRole("checkbox", {
        name: "Seleccionar Extracto Fila 1",
        exact: true,
      });
      yield* Effect.tryPromise(() => expect(checkbox).toHaveAccessibleDescription(/Mercado/u));
      yield* Effect.tryPromise(() => search.fill("Mercado"));
      yield* Effect.tryPromise(() => expect(checkbox).toHaveCount(1));
      yield* Effect.tryPromise(() => page.clock.fastForward("01:01"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Sin elementos en esta vista" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => search.fill(""));
      yield* Effect.tryPromise(() => expect(checkbox).toBeDisabled());
      yield* Effect.tryPromise(() =>
        expect(checkbox).toHaveAccessibleDescription(/Original vencido/u)
      );
      yield* Effect.tryPromise(() => expect(checkbox).not.toHaveAccessibleDescription(/Mercado/u));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("2026-10-01,25000,Mercado", { exact: true })).toHaveCount(0)
      );
    })
  ));

test("keeps loaded source excerpts through draft autosaves without rereading originals", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      const count = (): number => reads;
      const route = (request: Route): Promise<void> => {
        if (new URL(request.request().url()).pathname.endsWith("/context")) {
          reads++;
          return incompleteContextRoute([{ id, revision: 0, status: "pending", draft: undefined }])(
            request
          );
        }
        return reviewRoute(request);
      };
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, route)
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("2026-10-01,25000,Mercado", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        Promise.all([
          page.waitForResponse(isWorkspaceResponse),
          page.getByLabel("Valor", { exact: true }).fill("13500"),
        ])
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("status")).toContainText("Borrador guardado")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("2026-10-01,25000,Mercado", { exact: true })).toBeVisible()
      );
      expect(count()).toBe(1);
    })
  ));

const emailReviewItems = [
  { ...item, source: "email", createdAt: "2026-10-15T12:00:00Z" },
  { ...item, id: secondId, source: "email", createdAt: "2026-10-16T14:00:00Z" },
];
const emailReviewRoute = (route: Route): Promise<void> => {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith("/context")) {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response({
        items: emailReviewItems.map((entry, index) => ({
          id: entry.id,
          reference: `Elemento ${index + 1}`,
          receivedAt: entry.createdAt,
          expiresAt: entry.expiresAt,
        })),
      }),
    });
  }
  if (path.endsWith("/material")) {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response({
        available: true,
        text: "Asunto: Notificación bancaria\nCompra Farmacia COP 25000\nTransporte COP 18000",
        truncated: false,
      }),
    });
  }
  const selected = emailReviewItems.find((entry) => path.endsWith(entry.id));
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: response(
      selected === undefined
        ? { items: emailReviewItems, pendingCount: 2, total: 2 }
        : { item: selected, revision: 0 }
    ),
  });
};

test("identifies incomplete emails by receipt date and offers search inside their original", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, emailReviewRoute)
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(2));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: /Abrir Correo Elemento 2.*Recibido.*16\/10\/2026/u })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("textbox", { name: "Buscar pendientes en esta página" }).fill("16/10/2026")
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(1));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: /Abrir Correo Elemento 2/u }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("textbox", { name: "Buscar en este original" }).fill("Farmacia")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Compra Farmacia COP 25000", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Asunto: Notificación bancaria", { exact: true })).not.toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Transporte COP 18000", { exact: true })).not.toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("1 línea con coincidencias en este original.")).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(page.locator("mark")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        page.getByRole("textbox", { name: "Buscar en este original" }).fill("Mercado")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Sin coincidencias en este original.")).toBeVisible()
      );
    })
  ));

const isWorkspaceResponse = (response: BrowserResponse): boolean =>
  new URL(response.url()).pathname.endsWith("/review-workspace");

const unavailablePageRows = 2;
test("keeps fallback source references stable when filtering a later page without context", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entries = identifyIncompleteEntries(reviewPageSize + unavailablePageRows);
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace/context**`, unavailableContextRoute)
      );
      yield* Effect.tryPromise(() => page.goto(`/app/needs-review?offset=${reviewPageSize}`));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Reintentar fragmentos" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("checkbox", { name: "Seleccionar Extracto Elemento 52", exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("textbox", { name: "Buscar pendientes en esta página" }).fill("Elemento 52")
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(1));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("checkbox", { name: "Seleccionar Extracto Elemento 52", exact: true })
        ).toHaveAccessibleDescription(/Elemento 52/u)
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Abrir Extracto Elemento 52", exact: true })
        ).toBeVisible()
      );
    })
  ));

const unavailableContextRoute = (route: Route): Promise<void> =>
  route.fulfill({
    status: 503,
    body: '{"error":{"code":"service_unavailable","message":"Synthetic context refusal"}}',
  });

test("explains invalid review amounts before enabling confirmation", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, amountReviewRoute)
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      const amount = page.getByLabel("Valor", { exact: true });
      const confirm = page.getByRole("button", { name: "Confirmar", exact: true });
      yield* Effect.tryPromise(() => expect(amount).toHaveValue("12,5"));
      yield* Effect.tryPromise(() => amount.fill("0"));
      yield* Effect.tryPromise(() => amount.press("Tab"));
      yield* Effect.tryPromise(() =>
        expect(amount).toHaveAccessibleDescription("El monto debe ser mayor que cero.")
      );
      yield* Effect.tryPromise(() => expect(amount).toHaveAttribute("aria-invalid", "true"));
      yield* Effect.tryPromise(() => expect(confirm).toBeDisabled());
      yield* Effect.tryPromise(() => amount.fill(""));
      yield* Effect.tryPromise(() =>
        expect(amount).toHaveAccessibleDescription("Ingresa un monto mayor que cero.")
      );
      yield* Effect.tryPromise(() => amount.fill("12,501"));
      yield* Effect.tryPromise(() =>
        expect(amount).toHaveAccessibleDescription("Para COP, ingresa máximo 2 decimales.")
      );
      yield* Effect.tryPromise(() => amount.fill("12.500,50"));
      yield* Effect.tryPromise(() => expect(confirm).toBeEnabled());
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Café de prueba")
      );
    })
  ));

const amountReviewRoute = (route: Route): Promise<void> => {
  if (new URL(route.request().url()).pathname.endsWith(id)) {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response({
        item,
        revision: 0,
        suggestions: {
          amount: "12.5",
          currency: "COP",
          direction: "outflow",
          occurredAt: "2026-10-15T12:00:00Z",
          counterparty: "Café de prueba",
          userProvidedFields: [],
        },
      }),
    });
  }
  return reviewRoute(route);
};

const viewportScale = (): number => window.visualViewport?.scale ?? 0;
for (const currency of ["COP", undefined]) {
  test(`Review labels reflow with browser font preferences for ${currency ?? "missing Currency"}`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entries: Fixture[] = [
          {
            id,
            revision: 0,
            status: "pending",
            draft: {
              amount: "13500",
              currency,
              direction: "outflow",
              counterparty: "Cafe",
              occurredAt: "2026-01-01T12:00:00Z",
              userProvidedFields: [],
            },
          },
        ];
        yield* Effect.tryPromise(() => installUser(page));
        yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
        yield* Effect.tryPromise(() =>
          page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
        );
        yield* Effect.tryPromise(() => page.setViewportSize({ width: 320, height: 800 }));
        yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
        const form = page.locator('[data-review="fields"]');
        yield* expectFinancialLabels(form, "14px");
        // Chromium's default font preference changes text sizing without setting page zoom.
        const session = yield* Effect.tryPromise(() => page.context().newCDPSession(page));
        yield* Effect.tryPromise(() =>
          session.send("Page.setFontSizes", { fontSizes: { standard: 32 } })
        );
        yield* Effect.tryPromise(() => page.reload());
        yield* expectFinancialLabels(form, "28px");
        yield* Effect.tryPromise(() =>
          expect(page.getByLabel("Valor", { exact: true })).toHaveCSS("font-size", "32px")
        );
        expect(yield* Effect.tryPromise(() => page.evaluate(viewportScale))).toBe(1);
        yield* Effect.tryPromise(() => expectReviewReflow(page));
        yield* Effect.tryPromise(() => page.getByLabel("Valor", { exact: true }).focus());
        yield* Effect.tryPromise(() =>
          expect(page.getByLabel("Valor", { exact: true })).toBeFocused()
        );
        yield* Effect.tryPromise(() => session.detach());
      })
    ));
}

test("suppresses retained originals on page resume without waiting for suspended timers", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.clock.install({
          time: DateTime.toDateUtc(DateTime.makeUnsafe("2027-01-13T11:59:00Z")),
        })
      );
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, reviewRoute)
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Compra en Café — $13.500", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.clock.setSystemTime(DateTime.toDateUtc(DateTime.makeUnsafe("2027-01-13T12:01:00Z")))
      );
      yield* Effect.tryPromise(() => page.evaluate(resumeReviewPage));
      yield* Effect.tryPromise(() =>
        expect(page.locator('[data-review="original-body"]')).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Este elemento venció", exact: true })
        ).toBeVisible()
      );
    })
  ));

test("expires selected material at the earlier context deadline while retaining its review draft", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.clock.install({
          time: DateTime.toDateUtc(DateTime.makeUnsafe("2027-01-13T11:59:00Z")),
        })
      );
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, reviewRoute)
      );
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace/context**`, earlierOriginalContext)
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Compra en Café — $13.500", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.clock.fastForward("00:31"));
      yield* Effect.tryPromise(() =>
        expect(page.locator('[data-review="original-body"]')).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Mercado secreto", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("El original venció. Envía el material de nuevo para revisarlo.", {
            exact: true,
          })
        ).toBeVisible()
      );
    })
  ));

const resumeReviewPage = (): void => {
  window.dispatchEvent(new Event("pageshow"));
};
const earlierOriginalContext = (route: Route): Promise<void> =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: response({
      items: [
        { id, reference: "Fila 1", excerpt: "Mercado secreto", expiresAt: "2027-01-13T11:59:30Z" },
      ],
    }),
  });

test("keeps an original suppressed when page membership replaces its context query", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = replacingEvidencePage();
      yield* Effect.tryPromise(() =>
        page.clock.install({
          time: DateTime.toDateUtc(DateTime.makeUnsafe("2027-01-13T11:59:00Z")),
        })
      );
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, fixture.route)
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Mercado secreto", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Compra en Café — $13.500", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.clock.fastForward("00:31"));
      yield* Effect.tryPromise(() =>
        expect(page.locator('[data-review="original-body"]')).toHaveCount(0)
      );
      const reads = fixture.reads();
      fixture.replace();
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect.poll(fixture.contexts).toBeGreaterThan(1));
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(2));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Fragmento posterior", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.locator('[data-review="original-body"]')).toHaveCount(0)
      );
      expect(fixture.reads()).toBe(reads);
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Valor", { exact: true })).toBeVisible()
      );
    })
  ));

const replacingEvidencePage = (): Readonly<{
  route: (route: Route) => Promise<void>;
  reads: () => number;
  contexts: () => number;
  replace: () => void;
}> => {
  let replaced = false;
  let reads = 0;
  let contexts = 0;
  return {
    reads: () => reads,
    contexts: () => contexts,
    replace: () => {
      replaced = true;
    },
    route: (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/material")) {
        reads++;
        return reviewRoute(route);
      }
      if (path.endsWith("/context")) {
        contexts++;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: response({
            items: [
              {
                id,
                reference: "Fila 1",
                excerpt: replaced ? "Fragmento posterior" : "Mercado secreto",
                expiresAt: replaced ? item.expiresAt : "2027-01-13T11:59:30Z",
              },
            ],
          }),
        });
      }
      if (replaced && !path.endsWith(id) && !path.endsWith("/edits")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: response({
            pendingCount: 2,
            total: 2,
            items: [item, { ...item, id: "24000000-0000-4000-8000-000000001355" }],
          }),
        });
      }
      return reviewRoute(route);
    },
  };
};

for (const delayed of ["context", "material"] as const) {
  test(`suppresses late ${delayed} success after its original deadline`, ({ page }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = delayedEvidencePage(delayed);
        yield* Effect.tryPromise(() =>
          page.clock.install({
            time: DateTime.toDateUtc(DateTime.makeUnsafe("2027-01-13T11:59:00Z")),
          })
        );
        yield* Effect.tryPromise(() => installUser(page));
        yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
        yield* Effect.tryPromise(() =>
          page.route(`${apiOrigin}/ingestion/review-workspace**`, fixture.route)
        );
        yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
        yield* Effect.tryPromise(() => expect.poll(fixture.waiting).toBe(1));
        yield* Effect.tryPromise(() =>
          page.clock.setSystemTime(DateTime.toDateUtc(DateTime.makeUnsafe("2027-01-13T12:01:00Z")))
        );
        yield* Effect.tryPromise(fixture.release);
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Material tardío", { exact: true })).toHaveCount(0)
        );
        yield* Effect.tryPromise(() =>
          expect(page.locator('[data-review="original-body"]')).toHaveCount(0)
        );
        yield* Effect.tryPromise(() =>
          expect(
            page.getByRole("button", { name: "Reintentar original", exact: true })
          ).toHaveCount(0)
        );
      })
    ));
}

const delayedEvidencePage = (
  delayed: "context" | "material"
): Readonly<{
  route: (route: Route) => Promise<void>;
  waiting: () => number;
  release: () => Promise<void>;
}> => {
  const pending: Route[] = [];
  return {
    waiting: () => pending.length,
    route: (route) => {
      if (new URL(route.request().url()).pathname.endsWith(`/${delayed}`)) {
        pending.push(route);
        return Promise.resolve();
      }
      return reviewRoute(route);
    },
    release: () =>
      Promise.all(
        pending.map((route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: response(
              delayed === "material"
                ? { available: true, text: "Material tardío", truncated: false }
                : {
                    items: [
                      {
                        id,
                        reference: "Fila 1",
                        excerpt: "Material tardío",
                        expiresAt: item.expiresAt,
                      },
                    ],
                  }
            ),
          })
        )
      ).then(() => {}),
  };
};
