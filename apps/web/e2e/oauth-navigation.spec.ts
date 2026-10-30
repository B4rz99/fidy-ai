import type { Page } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { installOAuthReview, reviewReference } from "./oauth-visual-fixture";
import { signInNavigationThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const observationMilliseconds = 61_000;
const documentStartedAt = (): number => performance.timeOrigin;
const returnToOAuth = (): void => {
  const visitedWorkspaceSteps = -2;
  window.history.go(visitedWorkspaceSteps);
};
const focusWindow = (): void => {
  window.dispatchEvent(new Event("focus"));
};
const observeBudgetHover = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise(() =>
    page.getByRole("link", { name: "Presupuestos", exact: true }).hover()
  );
  // Observe forbidden speculative requests after an explicit hover, not just timer disposal.
  yield* Effect.sleep("100 millis");
});
const conditions = [
  { review: "loading", consent: "granted", identity: "navigationOAuthLoading" },
  { review: "unavailable", consent: "granted", identity: "navigationOAuthUnavailable" },
  { review: "unavailable", consent: "signed-out", identity: "navigationOAuthSignedOut" },
] as const;

const visitPrivateWorkspaces = Effect.fnUntraced(function* (page: Page) {
  const navigation = page.getByRole("navigation", { name: "Aplicación" });
  yield* Effect.tryPromise((signal) =>
    navigation.getByRole("link", { name: /^Por revisar/u }).click({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("heading", { name: "Por revisar", exact: true })).toBeVisible({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    navigation.getByRole("link", { name: "Recurrentes", exact: true }).click({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("button", { name: "Nuevo recurrente", exact: true })).toBeEnabled({
      signal,
    })
  );
});

for (const { identity, ...condition } of conditions) {
  test(`Returning to OAuth ${condition.review} with ${condition.consent} Consent disposes previously visited private workspaces`, ({
    page,
    request,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => signInNavigationThroughCore({ page, request, identity }));
        yield* Effect.tryPromise((signal) =>
          page.goto(`/oauth/review/${reviewReference}`, { signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(
            page.getByRole("main").getByRole("link", { name: "Iniciar sesión", exact: true })
          ).toBeVisible({ signal })
        );
        const startedAt = yield* Effect.tryPromise(() => page.evaluate(documentStartedAt));
        yield* visitPrivateWorkspaces(page);
        const observed = yield* installOAuthReview(page, { ...condition, mutation: "success" });
        yield* Effect.tryPromise(() => page.evaluate(returnToOAuth));
        yield* Effect.tryPromise((signal) =>
          expect(page).toHaveURL(new RegExp(`/oauth/review/${reviewReference}$`, "u"), { signal })
        );
        const continuedAt = yield* Effect.tryPromise(() => page.evaluate(documentStartedAt));
        expect(continuedAt).toBe(startedAt);
        yield* Effect.tryPromise((signal) =>
          expect(
            page.getByRole("heading", { name: "Por revisar", exact: true, includeHidden: true })
          ).toHaveCount(0, { signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(
            page.getByRole("button", { name: "Nuevo recurrente", exact: true, includeHidden: true })
          ).toHaveCount(0, { signal })
        );
        if (condition.review === "loading") {
          yield* Effect.tryPromise((signal) =>
            expect(page.getByRole("status")).toContainText("Cargando solicitud", { signal })
          );
        } else {
          yield* Effect.tryPromise((signal) =>
            expect(
              page.getByRole("main").getByRole("link", { name: "Iniciar sesión", exact: true })
            ).toBeVisible({ signal })
          );
        }
        yield* Effect.tryPromise(() => page.evaluate(focusWindow));
        yield* Effect.tryPromise(() => page.clock.fastForward(observationMilliseconds));
        yield* observeBudgetHover(page);
        yield* Effect.tryPromise((signal) =>
          expect(
            page.getByRole("heading", { name: "Por revisar", exact: true, includeHidden: true })
          ).toHaveCount(0, { signal })
        );
        expect(observed.unexpected).toEqual([]);
        expect(observed.mutations).toEqual([]);
        observed.release();
      })
    ));
}
