import type { Page } from "@playwright/test";

export const apiOrigin = "https://127.0.0.1:4174";
export const user = {
  id: "24000000-0000-4000-8000-000000000241",
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  trialPeriod: { startedAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-08T00:00:00Z" },
  createdAt: "2026-08-01T00:00:00Z",
};

export const response = (data: unknown): string => JSON.stringify({ data, next: [] });

export const installUser = async (page: Page): Promise<void> => {
  await page.route(`${apiOrigin}/user`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: response(user) })
  );
};

export const installCategories = async ({
  page,
  categories,
}: Readonly<{ page: Page; categories: unknown }>): Promise<void> => {
  await page.route(`${apiOrigin}/categories`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: response(categories) })
  );
};
