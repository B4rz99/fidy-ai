import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { type Cause, Effect, Option } from "effect";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RecurringPlanId, TransactionId } from "@/transport/client";
import { emptyTransactionFilters } from "@/features/recurring/transaction-filters";
import { useRecurringNavigation } from "@/features/recurring/navigation";
import { useRecurringWorkspaceView } from "@/features/recurring/workspace-view";

const item = {
  planId: RecurringPlanId.make("23200000-0000-4000-8000-000000000001"),
  date: "2026-11-15",
};

const transactionId = TransactionId.make("23200000-0000-4000-8000-000000000002");

const NavigationProbe = (): ReturnType<typeof createElement> => {
  const workspace = useRecurringWorkspaceView();

  const navigation = useRecurringNavigation({
    month: "2026-11",
    filters: workspace.filters,
    previous: workspace.previous,
  });

  return createElement(
    "main",
    null,
    createElement(
      "output",
      null,
      Option.match(navigation.selection, { onNone: () => "monthly", onSome: (value) => value.kind })
    ),
    createElement(
      "output",
      { "data-workspace": true },
      `${workspace.filters.search ?? ""}|${Option.getOrElse(workspace.previous, () => "")}`
    ),
    createElement(
      "button",
      { onClick: () => workspace.applyFilters({ search: "Internet" }) },
      "Filter workspace"
    ),
    createElement("button", { onClick: () => workspace.earlier("2026-08") }, "Earlier workspace"),
    createElement("button", { onClick: () => workspace.selectMonth("2026-12") }, "Next month"),
    createElement("button", { onClick: () => workspace.applyFilters({}) }, "Clear workspace"),
    createElement("button", { onClick: () => navigation.open(item) }, "Open occurrence"),
    createElement(
      "button",
      { onClick: () => navigation.link(item, emptyTransactionFilters) },
      "Open picker"
    ),
    createElement("button", { onClick: navigation.returnToOccurrence }, "Return to occurrence"),
    Option.match(navigation.browser, {
      onNone: () => null,
      onSome: (browser) =>
        createElement(
          "section",
          null,
          createElement(
            "output",
            { "data-search": true },
            `${browser.state.draft.text}|${browser.state.applied.text}|${browser.state.selectedId ?? "unselected"}`
          ),
          createElement(
            "button",
            {
              onClick: () =>
                browser.change({
                  ...browser.state,
                  draft: { ...browser.state.draft, text: "Internet" },
                }),
            },
            "Edit search"
          ),
          createElement(
            "button",
            {
              onClick: () =>
                browser.change({
                  ...browser.state,
                  applied: browser.state.draft,
                  selectedId: undefined,
                }),
            },
            "Apply search"
          ),
          createElement(
            "button",
            { onClick: () => browser.select(transactionId) },
            "Review result"
          ),
          createElement("button", { onClick: browser.clear }, "Close review"),
          createElement(
            "button",
            {
              onClick: () =>
                browser.change({
                  ...browser.state,
                  draft: { ...browser.state.draft, text: "Factura" },
                }),
            },
            "Change search"
          )
        ),
    })
  );
};

const reactWork = (work: () => void): Promise<void> =>
  Promise.resolve(act(() => Promise.resolve(work())));

const reactAssertion = (assertion: () => void): Promise<void> =>
  Promise.resolve(act(() => vi.waitFor(assertion)));

const click = (container: HTMLElement, text: string): Promise<void> =>
  reactWork(() => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === text
    );

    if (button === undefined) {
      throw new Error(`Missing ${text}`);
    }

    button.click();
  });

type NavigationRouter = ReturnType<typeof makeRouter>;

const makeRouter = (
  history: ReturnType<typeof createMemoryHistory>,
  binding: string
): ReturnType<typeof createRouter> => {
  const parent = createRootRoute({ component: NavigationProbe });

  const route = createRoute({
    getParentRoute: () => parent,
    path: "/app/recurring",
  });

  return createRouter({
    routeTree: parent.addChildren([
      route,
      createRoute({ getParentRoute: () => parent, path: "/app/transactions" }),
    ]),
    context: { sessionBinding: binding },
    history,
  });
};

type Harness = Readonly<{
  container: HTMLElement;
  router: NavigationRouter;
  reload: (binding: string) => Promise<void>;
}>;

const withNavigation = (
  run: (harness: Harness) => Effect.Effect<void, Cause.UnknownError>
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

      const history = createMemoryHistory({
        initialEntries: ["/app/transactions", "/app/recurring?month=2026-11"],
      });

      let router = makeRouter(history, "session-a");
      const container = document.createElement("div");
      let root = createRoot(container);

      const mount = (): Promise<void> =>
        router
          .load()
          .then(() => reactWork(() => root.render(createElement(RouterProvider, { router }))));

      const reload = (binding: string): Promise<void> =>
        reactWork(() => root.unmount()).then(() => {
          router = makeRouter(history, binding);
          root = createRoot(container);

          return mount();
        });

      try {
        yield* Effect.tryPromise(mount);
        yield* run({ container, router, reload });
      } finally {
        yield* Effect.tryPromise(() => reactWork(() => root.unmount()));
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    })
  );

const expectStep = (container: HTMLElement, step: string): Promise<void> =>
  reactAssertion(() => expect(container.querySelector("output")?.textContent).toBe(step));

const openPicker = (container: HTMLElement): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => click(container, "Open occurrence"));
    yield* Effect.tryPromise(() => expectStep(container, "occurrence"));
    yield* Effect.tryPromise(() => click(container, "Open picker"));
    yield* Effect.tryPromise(() => expectStep(container, "link"));
  });

it("browser Back from linking returns to the originating occurrence and Forward restores the picker", () =>
  withNavigation(({ container, router }) =>
    Effect.gen(function* () {
      yield* openPicker(container);
      yield* Effect.tryPromise(() => back(router));
      yield* Effect.tryPromise(() => expectStep(container, "occurrence"));
      expect(router.history.location.pathname).toBe("/app/recurring");
      yield* Effect.tryPromise(() => forward(router));
      yield* Effect.tryPromise(() => expectStep(container, "link"));
      yield* Effect.tryPromise(() => click(container, "Return to occurrence"));
      yield* Effect.tryPromise(() => expectStep(container, "occurrence"));
    })
  ));

it("review Back and close preserve the search, and reload restores the current read-only step", () =>
  withNavigation(({ container, router, reload }) =>
    Effect.gen(function* () {
      yield* openPicker(container);
      yield* Effect.tryPromise(() => click(container, "Edit search"));
      yield* Effect.tryPromise(() => click(container, "Apply search"));
      yield* Effect.tryPromise(() => expectSearch(container, "Internet|Internet|unselected"));
      yield* Effect.tryPromise(() => click(container, "Review result"));
      yield* Effect.tryPromise(() => expectSearch(container, transactionId));
      yield* Effect.tryPromise(() => back(router));
      yield* Effect.tryPromise(() => expectSearch(container, "Internet|Internet|unselected"));
      yield* Effect.tryPromise(() => forward(router));
      yield* Effect.tryPromise(() => expectSearch(container, transactionId));
      yield* Effect.tryPromise(() => reload("session-a"));
      yield* Effect.tryPromise(() => expectSearch(container, transactionId));
      yield* Effect.tryPromise(() => click(container, "Close review"));
      yield* Effect.tryPromise(() => expectSearch(container, "Internet|Internet|unselected"));
      yield* Effect.tryPromise(() => click(container, "Return to occurrence"));
      yield* Effect.tryPromise(() => expectStep(container, "occurrence"));
      yield* Effect.tryPromise(() => click(container, "Open picker"));
      yield* Effect.tryPromise(() => expectSearch(container, "Internet|Internet|unselected"));
    })
  ));

it("restoring history in a replacement authentication lifetime discards the occurrence and search", () =>
  withNavigation(({ container, reload }) =>
    Effect.gen(function* () {
      yield* openPicker(container);
      yield* Effect.tryPromise(() => click(container, "Edit search"));
      yield* Effect.tryPromise(() => reload("session-b"));
      yield* Effect.tryPromise(() => expectStep(container, "monthly"));
      expect(container.querySelector("[data-search]")).toBeNull();
    })
  ));

const expectSearch = (container: HTMLElement, text: string): Promise<void> =>
  reactAssertion(() =>
    expect(container.querySelector("[data-search]")?.textContent).toContain(text)
  );

const back = (router: NavigationRouter): Promise<void> => reactWork(() => router.history.back());

const forward = (router: NavigationRouter): Promise<void> =>
  reactWork(() => router.history.forward());

it("applying another search during review keeps close and Back on the current picker", () =>
  withNavigation(({ container, router }) =>
    Effect.gen(function* () {
      yield* openPicker(container);
      yield* Effect.tryPromise(() => click(container, "Edit search"));
      yield* Effect.tryPromise(() => click(container, "Apply search"));
      yield* Effect.tryPromise(() => click(container, "Review result"));
      yield* Effect.tryPromise(() => click(container, "Change search"));
      yield* Effect.tryPromise(() => click(container, "Apply search"));
      yield* Effect.tryPromise(() => expectSearch(container, "Factura|Factura|unselected"));
      yield* Effect.tryPromise(() => click(container, "Review result"));
      yield* Effect.tryPromise(() => click(container, "Close review"));
      yield* Effect.tryPromise(() => expectSearch(container, "Factura|Factura|unselected"));
      yield* Effect.tryPromise(() => back(router));
      yield* Effect.tryPromise(() => expectStep(container, "occurrence"));
    })
  ));

it("reload restores a filtered earlier workspace before restoring its picker and review", () =>
  withNavigation(({ container, reload }) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => click(container, "Filter workspace"));
      yield* Effect.tryPromise(() => click(container, "Earlier workspace"));
      yield* openPicker(container);
      yield* Effect.tryPromise(() => click(container, "Edit search"));
      yield* Effect.tryPromise(() => click(container, "Apply search"));
      yield* Effect.tryPromise(() => click(container, "Review result"));
      yield* Effect.tryPromise(() => reload("session-a"));
      yield* Effect.tryPromise(() => expectSearch(container, transactionId));
      expect(container.querySelector("[data-workspace]")?.textContent).toBe("Internet|2026-08");
      yield* Effect.tryPromise(() => reload("session-b"));
      yield* Effect.tryPromise(() => expectStep(container, "monthly"));
      expect(container.querySelector("[data-workspace]")?.textContent).toBe("|");
    })
  ));

it("month navigation retains workspace filters and earlier context without the prior picker", () =>
  withNavigation(({ container, router }) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => click(container, "Filter workspace"));
      yield* Effect.tryPromise(() => click(container, "Earlier workspace"));
      yield* openPicker(container);
      yield* Effect.tryPromise(() => click(container, "Next month"));
      yield* Effect.tryPromise(() => expectMonthWorkspace(container, router));
      yield* Effect.tryPromise(() => expectStep(container, "monthly"));
    })
  ));

const expectMonthWorkspace = (container: HTMLElement, router: NavigationRouter): Promise<void> =>
  reactAssertion(() => {
    expect(router.latestLocation.search).toEqual({ month: "2026-12" });
    expect(container.querySelector("[data-workspace]")?.textContent).toBe("Internet|2026-08");
  });

it("retained workspace filters survive sidebar departure and respect an explicit clear", () =>
  withNavigation(({ container, router, reload }) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => click(container, "Filter workspace"));
      yield* Effect.tryPromise(() => click(container, "Earlier workspace"));
      yield* Effect.tryPromise(() => visitRoute(router, "/app/transactions"));
      yield* Effect.tryPromise(() => visitRoute(router, "/app/recurring"));
      expect(container.querySelector("[data-workspace]")?.textContent).toBe("Internet|2026-08");
      yield* openPicker(container);
      yield* Effect.tryPromise(() => reload("session-a"));
      yield* Effect.tryPromise(() => expectStep(container, "link"));
      yield* Effect.tryPromise(() => click(container, "Return to occurrence"));
      yield* Effect.tryPromise(() => click(container, "Clear workspace"));
      yield* Effect.tryPromise(() => visitRoute(router, "/app/transactions"));
      yield* Effect.tryPromise(() => visitRoute(router, "/app/recurring"));
      expect(container.querySelector("[data-workspace]")?.textContent).toBe("|2026-08");
    })
  ));

const visitRoute = (
  router: NavigationRouter,
  to: "/app/transactions" | "/app/recurring"
): Promise<void> =>
  reactWork(() => {
    router.navigate({ to }).catch(() => undefined);
  });
