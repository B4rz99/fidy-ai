import type { Page } from "@playwright/test";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";

export const apiOrigin = browserAcceptanceTopology().api;
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

export const installUser = (page: Page): Promise<void> =>
  page
    .route(`${apiOrigin}/user`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: response(makeUser()),
      })
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
