import type { Page } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin, installUser, response } from "./http-fixtures";

const successStatus = 200;
const refusalStatus = 405;
const missingStatus = 404;
const token = {
  shortId: "demo0001",
  recipientLabel: "Agente personal",
  scopes: ["read", "write"],
  createdAt: "2026-10-24T14:00:00Z",
  lastUsedAt: "2026-10-25T14:00:00Z",
  expiresAt: "2026-11-23T14:00:00Z",
};
const tokens = [
  token,
  {
    ...token,
    shortId: "demo0002",
    recipientLabel: "Automatización",
    scopes: ["read"],
    createdAt: "2026-10-20T14:00:00Z",
    lastUsedAt: null,
    expiresAt: "2026-11-19T14:00:00Z",
  },
];
const connection = {
  connectionId: "10000000-0000-4000-8000-000000000001",
  claimedClientName: "Asistente de análisis",
  scopes: ["read"],
  permissions: [{ scope: "read", label: "Consultar tus datos", description: "Lectura" }],
  expiresAt: "2026-11-23T14:00:00Z",
  state: "active",
  recentActivity: [],
};
const reads = new Map([
  ["/web/session/binding", JSON.stringify({ binding: "10000000-0000-4000-8000-000000000002" })],
  ["/pats", response({ pats: tokens })],
  ["/web/oauth/connections", JSON.stringify({ connections: [connection], nextCursor: null })],
  ["/ingestion/review-workspace", response({ pendingCount: 0, total: 0, items: [] })],
]);

/** No request from this synthetic capture can execute a server mutation. */
export const installSettingsReads = Effect.fnUntraced(function* (page: Page) {
  const mutations: Array<string> = [];
  const missingReads: Array<string> = [];
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = reads.get(path);
      if (body === undefined) missingReads.push(path);
      return route.fulfill({
        status: body === undefined ? missingStatus : successStatus,
        contentType: "application/json",
        body: body ?? "{}",
      });
    })
  );
  yield* Effect.tryPromise(() => installUser(page));
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/**`, (route) => {
      const method = route.request().method();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.fallback();
      mutations.push(`${method} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ status: refusalStatus, body: "" });
    })
  );
  return { mutations, missingReads };
});
