import type { Page, Route } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin } from "./http-fixtures";
import {
  navigateThroughConsent,
  signInNavigationPerformanceThroughCore,
  signInNavigationThroughCore,
} from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { test, expect } = playwright;
const targetMilliseconds = 10;
const budgetTargetMilliseconds = 16;
const measurementSamples = 5;
const freshConsentTimeoutMilliseconds = 500;
const workspaces = [
  {
    name: "Transacciones",
    ready: "+ Registrar",
    path: "/transactions**",
    identity: "navigationTransactions",
  },
  {
    name: "Presupuestos",
    ready: "Mes anterior",
    path: "/budget-status**",
    identity: "navigationBudget",
  },
  {
    name: "Recurrentes",
    ready: "Nuevo recurrente",
    path: "/recurring-plans**",
    identity: "navigationRecurring",
  },
  {
    name: "Tablero",
    ready: "Personalizar",
    path: "/dashboard/view",
    identity: "navigationDashboard",
  },
] as const;

for (const workspace of workspaces) {
  test(`returns to ${workspace.name} from cached data while refreshing`, ({ page, request }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          signInNavigationPerformanceThroughCore({ page, request, identity: workspace.identity })
        );
        const development = yield* Effect.tryPromise(() =>
          page.locator('script[src="/@vite/client"]').count()
        );
        yield* Effect.tryPromise(() => openWorkspace(page, workspace.name));
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: workspace.ready, exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() => openWorkspace(page, "Por revisar"));
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("heading", { name: "Por revisar", exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() => page.route(`${apiOrigin}${workspace.path}`, delayedData));
        const samples: number[] = [];
        const count = workspace.name === "Transacciones" ? 1 : measurementSamples;
        for (let sample = 0; sample < count; sample++) {
          if (sample > 0) yield* Effect.tryPromise(() => openWorkspace(page, "Por revisar"));
          // Exercise expired display revalidation; recent returns now reuse the five-second snapshot.
          if (workspace.name === "Recurrentes" && sample === 0) yield* Effect.sleep("6 seconds");
          yield* Effect.tryPromise(() => page.evaluate(observeSwitch, workspace.ready));
          yield* Effect.tryPromise(() => revisitWorkspace(page, workspace.name));
          yield* Effect.tryPromise(() =>
            expect(page.getByRole("button", { name: workspace.ready, exact: true })).toBeVisible({
              timeout: workspace.name === "Transacciones" ? freshConsentTimeoutMilliseconds : 100,
            })
          );
          yield* Effect.tryPromise(() =>
            expect(page.locator("body")).toHaveAttribute(
              "data-workspace-switch-milliseconds",
              /[0-9]/u
            )
          );
          const milliseconds = yield* Effect.tryPromise(() =>
            page.locator("body").getAttribute("data-workspace-switch-milliseconds")
          );
          expect(milliseconds).not.toBeNull();
          samples.push(Number(milliseconds));
          if (workspace.name === "Recurrentes") {
            yield* Effect.tryPromise(() =>
              expect(
                page.getByRole("button", { name: workspace.ready, exact: true })
              ).toBeDisabled()
            );
          }
        }
        yield* Effect.tryPromise(() => recordSamples(workspace.name, samples, development));
      })
    ));
}

const recordSamples = (
  name: string,
  samples: ReadonlyArray<number>,
  development: number
): Promise<void> => {
  const median = samples.toSorted((left, right) => left - right)[Math.floor(samples.length / 2)];
  return test
    .info()
    .attach("workspace-switch-duration", {
      body: `${name}: median ${median} ms; samples ${samples.join(", ")} ms`,
      contentType: "text/plain",
    })
    .then(() => {
      if (development === 0 && name !== "Transacciones") {
        expect(median).toBeLessThanOrEqual(
          name === "Presupuestos" ? budgetTargetMilliseconds : targetMilliseconds
        );
      }
    });
};

const openWorkspace = (page: Page, name: string): Promise<void> =>
  page.getByRole("link", { name: new RegExp(`^${name}(?: \\d+ pendientes)?$`, "u") }).click();

const revisitWorkspace = (page: Page, name: string): Promise<void> =>
  name === "Transacciones"
    ? navigateThroughConsent({ page, navigate: () => openWorkspace(page, name) })
    : openWorkspace(page, name);

const observeSwitch = (ready: string): void => {
  delete document.body.dataset.workspaceSwitchMilliseconds;
  document.addEventListener(
    "click",
    () => {
      const start = performance.now();
      const observer = new MutationObserver(() => {
        const found = Array.from(document.querySelectorAll("button")).some(
          (button) =>
            (button.getAttribute("aria-label") ?? button.textContent.trim()) === ready &&
            button.getClientRects().length > 0
        );
        if (!found) return;
        document.body.dataset.workspaceSwitchMilliseconds = String(performance.now() - start);
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    },
    { capture: true, once: true }
  );
};
const delayedData = (route: Route): Promise<void> =>
  Effect.runPromise(
    Effect.sleep("1 second").pipe(Effect.andThen(Effect.tryPromise(() => route.continue())))
  );

test("dismisses a recurring editor when leaving its retained workspace", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationThroughCore({ page, request, identity: "navigationRecurring" })
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => openWorkspace(page, "Recurrentes"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Nuevo recurrente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Nombre", { exact: true }).fill("Borrador conservado")
      );
      yield* Effect.tryPromise(() => page.goBack());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Por revisar", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("dialog", { includeHidden: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => page.goForward());
      yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Nuevo recurrente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("")
      );
      yield* Effect.tryPromise(() => page.goBack());
      yield* Effect.tryPromise(() =>
        page
          .getByRole("navigation", { name: "Aplicación" })
          .getByText("Ajustes", { exact: true })
          .click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Privacidad", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Nombre", { exact: true })).toHaveCount(0)
      );
    })
  ));

test("refreshes the retained recurring default month after midnight", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationThroughCore({ page, request, identity: "navigationClock" })
      );
      yield* Effect.tryPromise(() => page.clock.setFixedTime("2026-11-01T04:59:00Z"));
      yield* Effect.tryPromise(() => page.goto("/app/recurring"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: /octubre de 2026/iu })).toBeVisible()
      );
      yield* Effect.tryPromise(() => openWorkspace(page, "Por revisar"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Por revisar", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.clock.setFixedTime("2026-11-01T05:01:00Z"));
      yield* Effect.tryPromise(() => page.goBack());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: /noviembre de 2026/iu })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Mes anterior", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: /octubre de 2026/iu })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Mes siguiente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: /noviembre de 2026/iu })).toBeVisible()
      );
    })
  ));
