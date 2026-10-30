import { expectSameLoadingFrame, measureLoadingFrame } from "./loading-geometry";
import { signInNavigationPerformanceThroughCore, signInThroughCore } from "./real-core-fixture";
import type { Page, Route } from "@playwright/test";
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
          item,
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
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response([
        {
          item,
          revision: 1,
          draft: Schema.decodeUnknownSync(
            Schema.Struct({ draft: Schema.optionalKey(Schema.Unknown) })
          )(route.request().postDataJSON()).draft,
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
        expect(page.getByRole("checkbox", { name: `Seleccionar Extracto ${id}` })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("checkbox", { name: `Seleccionar Extracto ${secondId}` })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Deshacer omisión" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(2));
      yield* Effect.tryPromise(() =>
        page.getByRole("checkbox", { name: `Seleccionar Extracto ${id}` }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("checkbox", { name: `Seleccionar Extracto ${secondId}` }).click()
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
        expect(page.getByRole("checkbox", { name: `Seleccionar Extracto ${id}` })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("checkbox", { name: `Seleccionar Extracto ${secondId}` })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Historial", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Transacción creada", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("link", { name: "Ver transacción" })).toHaveCount(0)
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
        page.getByRole("button", { name: "Actualizar elemento" }).click()
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
        expect(page.getByRole("checkbox", { name: `Seleccionar Extracto ${id}` })).not.toBeChecked()
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
            .getByText("Por revisar", { exact: true })
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
for (const picker of reviewPickers) {
  const pickerName = new RegExp(`^${RegExp.escape(picker.label)}(?:$|:)`, "u");
  test(`dismisses ${picker.label} when leaving the retained review`, ({ page, request }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => signInThroughCore({ page, request }));
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
        yield* Effect.tryPromise(() => page.goto("/app/recurring"));
        yield* Effect.tryPromise(() => page.getByRole("link", { name: /^Por revisar/u }).click());
        yield* Effect.tryPromise(() =>
          page.getByRole(picker.trigger, { name: pickerName }).click()
        );
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
        yield* Effect.tryPromise(() =>
          page.getByRole(picker.trigger, { name: pickerName }).click()
        );
        yield* Effect.tryPromise(() => expect(page.getByRole(picker.popup)).toBeVisible());
        yield* Effect.tryPromise(() => page.goBack());
        yield* verifyHiddenReview(page, picker.popup);
        yield* Effect.tryPromise(() => page.goForward());
        yield* Effect.tryPromise(() => expect(page.getByRole(picker.popup)).toHaveCount(0));
        yield* Effect.tryPromise(() =>
          expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Café")
        );
      })
    ));
}

test("clears bulk selection when filtering and retains paging after no local matches", ({ page }) =>
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
      yield* Effect.tryPromise(() => expect(page.getByRole("checkbox").first()).not.toBeChecked());
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
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/offset=50/));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Anterior", exact: true })).toBeEnabled()
      );
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
            expect(loading.locator('[data-slot="skeleton"]').first()).toBeVisible()
          );
          yield* Effect.tryPromise(() =>
            expect(loading.getByText(copy, { exact: true })).toHaveClass("sr-only")
          );
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
  test(`Review skeleton matches the loaded frame at desktop width ${width}`, ({ page }) => {
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
        const frameParts = ["grid", "inbox", "detail", "columns"].map((name) => ({
          name,
          selector: `[data-review="${name}"]`,
        }));
        const loadingFrame = yield* Effect.tryPromise(() => measureLoadingFrame(page, frameParts));
        release.resolve();
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Confirmar", exact: true })).toBeVisible()
        );
        const loadedFrame = yield* Effect.tryPromise(() => measureLoadingFrame(page, frameParts));
        expectSameLoadingFrame(loadingFrame, loadedFrame);
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
    );
  });
}
