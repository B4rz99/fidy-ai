import type { Route } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { signInRecurringThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
const workspaceRoute = `${apiOrigin}/recurring-plans?*`;
const unavailableStatus = 503;
const successStatus = 200;
const limitedStatus = 429;

const failures = [
  {
    kind: "unavailable",
    status: unavailableStatus,
    body: '{"error":{"code":"unavailable","message":"private-recurring-diagnostic"},"next":[]}',
  },
  {
    kind: "malformed",
    status: successStatus,
    body: '{"data":{"month":"2026-10","occurrences":[{"name":"Untrusted partial fact"}]},"next":[]}',
  },
  {
    kind: "limited",
    status: limitedStatus,
    body: '{"_tag":"ResourceLimited","error":{"code":"rate_limited","message":"private-recurring-diagnostic","retryAfterSeconds":3600},"next":[]}',
  },
] as const;
for (const failure of failures) {
  test(`a ${failure.kind} recurring read refuses false empty facts and recovers through explicit retry`, ({
    page,
    request,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          signInRecurringThroughCore({ page, request, identity: "recurringRecovery" })
        );
        const title =
          failure.kind === "limited"
            ? "Alcanzaste el límite diario de solicitudes"
            : "No pudimos cargar tus recurrentes";
        const handler = (route: Route): Promise<void> =>
          route.fulfill({
            status: failure.status,
            contentType: "application/json",
            headers: { "retry-after": "3600" },
            body: failure.body,
          });
        yield* Effect.tryPromise(() => page.route(workspaceRoute, handler));
        yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
        yield* Effect.tryPromise(() =>
          expect(page.getByText(title, { exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Sin recurrentes para este mes", { exact: true })).toHaveCount(0)
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText("private-recurring-diagnostic")).toHaveCount(0)
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Untrusted partial fact")).toHaveCount(0)
        );
        yield* Effect.tryPromise(() => page.unroute(workspaceRoute, handler));
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Reintentar", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("heading", { name: "Recurrentes", exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText(title, { exact: true })).toHaveCount(0)
        );
      })
    ));
}
