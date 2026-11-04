import type { Page } from "@playwright/test";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";

export const apiOrigin = browserAcceptanceTopology().app;
/** Same-origin API fixtures leave documents and static resources with the Web Worker. */
export const routeBrowserApi = (
  page: Page,
  url: Parameters<Page["route"]>[0],
  handler: Parameters<Page["route"]>[1]
): Promise<void> =>
  page.route(url, (route, request) => {
    const resource = request.resourceType();
    return resource === "fetch" || resource === "xhr" ? handler(route, request) : route.fallback();
  });
const defaultUser = {
  id: "24000000-0000-4000-8000-000000000241",
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  trialPeriod: { startedAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-08T00:00:00Z" },
  createdAt: "2026-08-01T00:00:00Z",
};

type UserFixture = typeof defaultUser;
export const makeUser = (overrides: Partial<UserFixture> = {}): UserFixture => ({
  ...defaultUser,
  ...overrides,
});

export const response = (data: unknown): string => JSON.stringify({ data, next: [] });

// Presentation fixtures have no live authority for unrelated speculative product reads.
const presentationConnection = (): void => {
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: { saveData: true, effectiveType: "4g" },
  });
};

export const installUser = (page: Page): Promise<void> =>
  page
    .addInitScript(presentationConnection)
    .then(() =>
      page.route(`${apiOrigin}/user`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: response(makeUser()),
        })
      )
    )
    .then(() =>
      page.route(`${apiOrigin}/web/consent`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "Granted", withdrawal: null }),
        })
      )
    )
    .then(() => {});

export const installCategories = ({
  page,
  categories,
}: Readonly<{ page: Page; categories: unknown }>): Promise<void> =>
  page
    .route(`${apiOrigin}/categories`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: response(categories) })
    )
    .then(() => {});
