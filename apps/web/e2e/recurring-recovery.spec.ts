import type { Page, Route } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { signInRecurringThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
test.describe.configure({ mode: "parallel" });
const workspaceRoute = `${apiOrigin}/recurring-plans?*`;
const unavailableStatus = 503;
const successStatus = 200;
const limitedStatus = 429;
const expectReadFailure = expect.configure({ timeout: 10000 });

const failures = [
  {
    kind: "unavailable",
    identity: "recurringRecoveryUnavailable",
    retry: "3600",
    status: unavailableStatus,
    body: '{"error":{"code":"unavailable","message":"private-recurring-diagnostic"},"next":[]}',
  },
  {
    kind: "malformed",
    identity: "recurringRecoveryMalformed",
    retry: "3600",
    status: successStatus,
    body: '{"data":{"month":"2026-10","occurrences":[{"name":"Untrusted partial fact"}]},"next":[]}',
  },
  {
    kind: "limited",
    identity: "recurringRecoveryLimited",
    retry: "3600",
    status: limitedStatus,
    body: '{"_tag":"ResourceLimited","error":{"code":"rate_limited","message":"private-recurring-diagnostic","retryAfterSeconds":3600},"next":[]}',
  },
  {
    kind: "pressure",
    identity: "recurringRecoveryPressure",
    retry: "1",
    status: limitedStatus,
    body: '{"_tag":"ResourceLimited","error":{"code":"rate_limited","message":"Too many concurrent or recent requests. Retry later.","retryAfterSeconds":1},"next":[]}',
  },
] as const;
/** Keep background rereads failed until the actual retry click makes the endpoint available. */
const allowExplicitRetry = (page: Page): Promise<void> =>
  page.getByRole("button", { name: "Reintentar", exact: true }).evaluate((button) => {
    button.addEventListener(
      "click",
      () => {
        document.documentElement.dataset.recurringRetryRequested = "true";
      },
      { capture: true, once: true }
    );
  });

for (const failure of failures) {
  test(`a ${failure.kind} recurring read refuses false empty facts and recovers through explicit retry`, ({
    page,
    request,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          signInRecurringThroughCore({ page, request, identity: failure.identity })
        );
        const title =
          failure.status === limitedStatus
            ? "Alcanzaste el límite de solicitudes"
            : "No pudimos cargar tus recurrentes";
        const handler = (route: Route): Promise<void> =>
          page
            .evaluate(() => document.documentElement.dataset.recurringRetryRequested === "true")
            .then((retrying) =>
              retrying
                ? route.continue()
                : route.fulfill({
                    status: failure.status,
                    contentType: "application/json",
                    headers: { "retry-after": failure.retry },
                    body: failure.body,
                  })
            );
        yield* Effect.tryPromise(() => page.route(workspaceRoute, handler));
        yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
        yield* Effect.tryPromise(() =>
          expectReadFailure(page.getByText(title, { exact: true })).toBeVisible()
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
        const retry = page.getByRole("button", { name: "Reintentar", exact: true });
        yield* Effect.tryPromise(() => expect(retry).toBeEnabled());
        yield* Effect.tryPromise(() => allowExplicitRetry(page));
        yield* Effect.tryPromise(() => retry.click());
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("heading", { name: "Recurrentes", exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByText(title, { exact: true })).toHaveCount(0)
        );
      })
    ));
}
