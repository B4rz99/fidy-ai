import type { Page, Route } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin } from "./http-fixtures";
import {
  signInBudgetThroughCore,
  signInDashboardThroughCore,
  signInRecurringThroughCore,
  signInThroughCore,
} from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { test, expect } = playwright;
const targetMilliseconds = 10;
const measurementSamples = 5;
const freshConsentTimeoutMilliseconds = 500;
const workspaces = [
  {
    name: "Transacciones",
    ready: "+ Registrar",
    path: "/transactions**",
    signIn: signInThroughCore,
  },
  {
    name: "Presupuestos",
    ready: "Mes anterior",
    path: "/budget-status**",
    signIn: signInBudgetThroughCore,
  },
  {
    name: "Recurrentes",
    ready: "Nuevo recurrente",
    path: "/recurring-plans**",
    signIn: (input: Parameters<typeof signInThroughCore>[0]): Promise<void> =>
      signInRecurringThroughCore({ ...input, identity: "recurring" }),
  },
  {
    name: "Tablero",
    ready: "Personalizar",
    path: "/dashboard/view",
    signIn: signInDashboardThroughCore,
  },
] as const;

for (const workspace of workspaces) {
  test(`returns to ${workspace.name} from cached data while refreshing`, ({ page, request }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => workspace.signIn({ page, request }));
        yield* Effect.tryPromise(() => page.clock.resume());
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
          yield* Effect.tryPromise(() => page.evaluate(observeSwitch, workspace.ready));
          yield* Effect.tryPromise(() => openWorkspace(page, workspace.name));
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
        }
        const median = samples.toSorted((left, right) => left - right)[Math.floor(count / 2)];
        yield* Effect.tryPromise(() =>
          test.info().attach("workspace-switch-duration", {
            body: `${workspace.name}: median ${median} ms; samples ${samples.join(", ")} ms`,
            contentType: "text/plain",
          })
        );
        // Keep the 10 ms render target on built assets; repeated samples avoid a single
        // operating-system scheduling pause deciding the benchmark on shared CI runners.
        // Every individual switch must still reveal cached content before delayed data returns.
        if (development === 0 && workspace.name !== "Transacciones") {
          expect(median).toBeLessThanOrEqual(targetMilliseconds);
        }
      })
    ));
}

const openWorkspace = (page: Page, name: string): Promise<void> =>
  page.getByRole("link", { name: new RegExp(`^${name}(?: \\d+ pendientes)?$`, "u") }).click();

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
