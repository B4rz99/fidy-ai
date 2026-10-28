import type { Page, Route } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin } from "./http-fixtures";

export const reviewReference = "10000000-0000-4000-8000-000000000001";
const connection = {
  requestId: reviewReference,
  claimedClientName: "Agente de ejemplo",
  scopes: ["read", "write", "dashboard"],
  permissions: [
    {
      scope: "read",
      label: "Consultar tus datos",
      description: "Consultar tus datos financieros en Fidy.",
    },
    {
      scope: "write",
      label: "Crear y modificar tus datos",
      description: "Crear y modificar tus datos financieros en Fidy.",
    },
    {
      scope: "dashboard",
      label: "Ver y editar tu tablero",
      description: "Consultar y modificar tu tablero financiero en Fidy.",
    },
  ],
  reviewedAt: "2026-10-27T13:00:00Z",
  requestExpiresAt: "2026-10-27T13:15:00Z",
  connectAvailable: true,
};
export type ReviewState = "ready" | "loading" | "unavailable";
export type ConsentState = "granted" | "loading" | "unavailable" | "revoked" | "signed-out";
export type MutationState = "success" | "unknown" | "pending";

type FixtureOptions = Readonly<{
  review: ReviewState;
  consent: ConsentState;
  mutation: MutationState;
}>;
const unavailableStatus = 503;
const missingStatus = 404;
const refusedStatus = 405;
const unauthenticatedStatus = 401;
const fulfill = (route: Route, body: unknown, status = 200): Promise<void> =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
const consentResponse = (route: Route, state: ConsentState, held: Promise<void>): Promise<void> => {
  if (state === "unavailable" || state === "signed-out") {
    return fulfill(route, {}, unauthenticatedStatus);
  }
  const body =
    state === "revoked"
      ? {
          status: "Revoked",
          withdrawal: {
            reference: "10000000-0000-4000-8000-000000000006",
            occurredAtMs: 1793106000000,
          },
        }
      : { status: "Granted", withdrawal: null };
  return state === "loading" ? held.then(() => fulfill(route, body)) : fulfill(route, body);
};
const reviewResponse = (route: Route, state: ReviewState, held: Promise<void>): Promise<void> => {
  if (state === "unavailable") return fulfill(route, {}, missingStatus);
  const body = connection;
  return state === "loading" ? held.then(() => fulfill(route, body)) : fulfill(route, body);
};
const mutationResponse = (
  route: Route,
  state: MutationState,
  held: Promise<void>
): Promise<void> => {
  const path = new URL(route.request().url()).pathname;
  if (state === "unknown" || path === "/web/oauth/connect") {
    return fulfill(route, {}, unavailableStatus);
  }
  const body = path === "/web/oauth/cancel" ? { cancelled: true } : { decided: true };
  return state === "pending" ? held.then(() => fulfill(route, body)) : fulfill(route, body);
};

/** Every synthetic request stays inside this fixture; unlisted reads and writes are refused. */
export const installOAuthReview = Effect.fnUntraced(function* (
  page: Page,
  options: FixtureOptions = { review: "ready", consent: "granted", mutation: "success" }
) {
  const unexpected: Array<string> = [];
  const mutations: Array<Readonly<{ path: string; body: string }>> = [];
  const held = Promise.withResolvers<void>();
  const handler = (route: Route): Promise<void> => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      mutations.push({ path, body: request.postData() ?? "" });
      if (["/web/oauth/cancel", "/web/oauth/connect"].includes(path)) {
        return mutationResponse(route, options.mutation, held.promise);
      }
      unexpected.push(path);
      return fulfill(route, {}, refusedStatus);
    }
    if (path === "/web/session/binding") {
      return fulfill(route, {
        binding: options.consent === "signed-out" ? null : "10000000-0000-4000-8000-000000000005",
      });
    }
    if (path === "/web/consent") return consentResponse(route, options.consent, held.promise);
    if (path === "/web/oauth/review") {
      return reviewResponse(route, options.review, held.promise);
    }
    unexpected.push(path);
    return fulfill(route, {}, missingStatus);
  };
  yield* Effect.tryPromise(() => page.route(`${apiOrigin}/**`, handler));
  return { unexpected, mutations, release: (): void => held.resolve() };
});
