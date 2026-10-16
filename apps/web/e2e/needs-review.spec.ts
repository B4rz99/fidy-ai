import type { Route } from "@playwright/test";
import { Effect, Schema } from "effect";
import { apiOrigin, installCategories, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
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
        expect(page.getByRole("button", { name: "Crear transacción", exact: true })).toBeDisabled()
      );
    })
  ));

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
    body: response({ pendingCount: 1, total: 1, items: [item] }),
  });
};

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
    if (path.endsWith("/suggestions")) {
      return route.fulfill({
        status: 503,
        body: '{"error":{"code":"unavailable","message":"Try later"}}',
      });
    }
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

test("skips and restores in bulk, advances, and preserves edits after a failed retry", ({ page }) =>
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
        page.getByRole("button", { name: "Reintentar procesamiento" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText(/Tus cambios se conservan/)).toBeVisible()
      );
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

test("creates individually and advances to the next pending item", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const draft = {
        amount: "13500",
        currency: "COP",
        direction: "outflow",
        counterparty: "Café",
        occurredAt: "2026-01-01T12:00:00Z",
        userProvidedFields: [],
      };
      const entries: Fixture[] = [id, secondId].map((value) => ({
        id: value,
        revision: 0,
        status: "pending",
        draft,
      }));
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/ingestion/review-workspace**`, lifecycleRoute(entries))
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Crear transacción", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("checkbox", { name: `Seleccionar Extracto ${id}` })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("checkbox", { name: `Seleccionar Extracto ${secondId}` })
        ).toBeVisible()
      );
      expect(entries.filter((entry) => entry.status === "created")).toHaveLength(1);
    })
  ));

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
        expect(page.getByRole("button", { name: "Crear transacción", exact: true })).toBeDisabled()
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
        page.getByRole("button", { name: "Omitir 1 seleccionados" }).click()
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
        page.getByRole("button", { name: "Crear transacción", exact: true }).click()
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
        expect(page.getByText("Confirma la moneda para continuar.")).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Crear transacción", exact: true })).toBeDisabled()
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
        expect(page.getByRole("button", { name: "Crear transacción", exact: true })).toBeEnabled()
      );
    })
  ));
