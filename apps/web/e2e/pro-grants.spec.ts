import type { Route } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { apiOrigin, response } from "./http-fixtures";
import { installSubscriptionFixture, paidStanding } from "./subscription-visual-fixture";

const { test, expect } = playwright;
const grantedResponse = (route: Route): Promise<void> =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: response({
      ...paidStanding,
      paidSubscription: null,
      recentAttempts: [],
      hasProGrant: true,
    }),
  });
test("manually granted users see normal Pro access without a trial countdown or purchase prompt", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* installSubscriptionFixture(page, "paid");
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/subscription/status`, grantedResponse)
      );
      yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("heading", { name: "Tu acceso: Pro" })).toBeVisible({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByText(/Período de prueba/iu)).toHaveCount(0, { signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByRole("button", { name: "Consultar cancelación", exact: true })
        ).toHaveCount(0, { signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: "Activar Pro", exact: true })).toHaveCount(0, {
          signal,
        })
      );
    })
  ));
