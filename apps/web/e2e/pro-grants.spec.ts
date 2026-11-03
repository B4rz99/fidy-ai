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
    Effect.scoped(
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
    )
  ));

const holdGrantedResponse =
  (gate: Promise<void>): ((route: Route) => Promise<void>) =>
  (route): Promise<void> =>
    gate.then(() => grantedResponse(route));
const failedStanding = (route: Route): Promise<void> =>
  route.fulfill({
    status: 503,
    contentType: "application/json",
    body: response({ error: "unavailable" }),
  });

for (const state of ["pending", "failed"] as const) {
  test(`purchase controls stay hidden when subscription standing is ${state}`, ({ page }) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* installSubscriptionFixture(page, "form");
          const gate = Promise.withResolvers<void>();
          yield* Effect.addFinalizer(() => Effect.sync(gate.resolve));
          yield* Effect.tryPromise(() =>
            page.route(
              `${apiOrigin}/subscription/status`,
              state === "pending" ? holdGrantedResponse(gate.promise) : failedStanding
            )
          );
          const offersLoaded = page.waitForResponse(`${apiOrigin}/subscription/offers`);
          yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
          yield* Effect.tryPromise(() => offersLoaded);
          yield* Effect.tryPromise((signal) =>
            expect(page.getByRole("button", { name: /^Continuar con/iu })).toHaveCount(0, {
              signal,
            })
          );
          yield* Effect.tryPromise((signal) =>
            expect(page.getByRole("complementary", { name: "Tu elección" })).toHaveCount(0, {
              signal,
            })
          );
          gate.resolve();
          if (state === "pending") {
            yield* Effect.tryPromise((signal) =>
              expect(page.getByRole("heading", { name: "Tu acceso: Pro" })).toBeVisible({ signal })
            );
          } else {
            yield* Effect.tryPromise((signal) =>
              expect(page.getByText("Estado no disponible", { exact: true })).toBeVisible({
                signal,
              })
            );
          }
        })
      )
    ));
}

const refreshToGrant = (gate: Promise<void>): ((route: Route) => Promise<void>) => {
  let requests = 0;
  const held = holdGrantedResponse(gate);
  return (route): Promise<void> => {
    requests += 1;
    if (requests > 1) return held(route);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response({
        ...paidStanding,
        accessTier: "free",
        hasProGrant: false,
        paidSubscription: null,
        recentAttempts: [],
      }),
    });
  };
};
test("a manual Pro grant discovered during checkout hides the unsubmitted payment form", ({
  page,
}) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* installSubscriptionFixture(page, "form");
        const gate = Promise.withResolvers<void>();
        yield* Effect.addFinalizer(() => Effect.sync(gate.resolve));
        yield* Effect.tryPromise(() =>
          page.route(`${apiOrigin}/subscription/status`, refreshToGrant(gate.promise))
        );
        yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
        yield* Effect.tryPromise((signal) =>
          page.getByRole("button", { name: /^mensual\b/iu }).click({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          page.getByRole("button", { name: "Actualizar estado", exact: true }).click({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          page.getByRole("button", { name: "Continuar con tarjeta", exact: true }).click({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("button", { name: "Cambiar selección", exact: true })).toBeVisible({
            signal,
          })
        );
        gate.resolve();
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("heading", { name: "Tu acceso: Pro" })).toBeVisible({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("button", { name: "Activar Pro", exact: true })).toHaveCount(0, {
            signal,
          })
        );
      })
    )
  ));
