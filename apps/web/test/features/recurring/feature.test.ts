import { RegistryContext } from "@effect/atom-react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { type Cause, Effect, Layer, Match, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { RecurringFeature } from "@/features/recurring/feature";

const plans = [
  { id: "24000000-0000-4000-8000-000000017231", name: "Arriendo de prueba", kind: "expense" },
  { id: "24000000-0000-4000-8000-000000017232", name: "Ingreso de prueba", kind: "income" },
].map(({ id, name, kind }) => ({
  id,
  pauses: [],
  revisions: [
    {
      from: "2026-10-31",
      plan: {
        name,
        kind,
        currency: "COP",
        amountMode: "unknown",
        frequency: "monthly",
        firstDate: "2026-10-31",
        timeZone: "America/Bogota",
      },
    },
  ] as const,
}));

const workspace = {
  document: {
    revision: 2,
    plans,
    exceptions: [],
    fulfillments: [],
    excludedTransactionIds: [],
    suggestions: [],
  },
  month: "2026-10",
  today: "2026-10-15",
  occurrences: plans.map((plan) => ({
    planId: plan.id,
    date: "2026-10-31",
    expectedDate: "2026-10-31",
    plan: plan.revisions[0].plan,
    status: "upcoming",
    completed: { amount: "0", currency: "COP" },
    fulfillments: [],
  })),
  previous: [],
  summary: [],
  linkedTransactions: [],
  invalidFulfillmentIds: [],
  matches: [],
  matchesComplete: true,
};

const reactWork = (work: () => void): Promise<void> =>
  Promise.resolve(act(() => Promise.resolve(work())));

const reactAssertion = (assertion: () => void): Promise<void> =>
  vi.waitFor(() => reactWork(() => undefined).then(assertion));

const button = (container: HTMLElement, label: string): HTMLButtonElement => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent.trim() === label
  );

  if (found === undefined) {
    throw new Error(`Missing ${label}`);
  }

  return found;
};

const click = (container: HTMLElement, label: string): Promise<void> =>
  reactWork(() => button(container, label).click());

const searchFor = (container: HTMLElement, search: string): Promise<void> =>
  reactWork(() => {
    const input = container.querySelector('input[name="search"]');

    if (!Schema.is(Schema.instanceOf(HTMLInputElement))(input)) {
      throw new Error("Missing recurrentes search");
    }

    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, search);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

const Workspace = (): ReturnType<typeof createElement> => {
  const props = {
    month: Option.some("2026-10"),
    captureEditor: (): ReturnType<typeof createElement> => createElement("div"),
    children: null,
  };

  return createElement(RecurringFeature, props);
};

const withWorkspace = (
  check: (container: HTMLElement) => Effect.Effect<void, Cause.UnknownError>
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("matchMedia", () => ({
        matches: false,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
      }));
      vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

      const http = HttpClient.make((request) => {
        const path = new URL(request.url).pathname;
        const params = new Map(request.urlParams);
        const search = Schema.decodeUnknownSync(Schema.String)(params.get("search") ?? "");
        const earlier = params.get("previousMonth") === "2026-08";

        const result =
          path === "/user"
            ? {
                data: {
                  id: "10000000-0000-4000-8000-000000000001",
                  serviceMarket: "CO",
                  locale: "es-CO",
                  timeZone: "America/Bogota",
                  createdAt: "2026-08-01T00:00:00Z",
                  trialPeriod: {
                    startedAt: "2026-08-01T00:00:00Z",
                    endsAt: "2026-08-08T00:00:00Z",
                  },
                },
                categories: [],
                next: [],
              }
            : {
                data: {
                  ...workspace,
                  previousMonth: earlier ? "2026-07" : "2026-08",
                  previous: earlier
                    ? workspace.occurrences.slice(0, 1).map((item) => ({
                        ...item,
                        date: "2026-08-31",
                        expectedDate: "2026-08-31",
                        status: "unconfirmed",
                      }))
                    : [],
                  occurrences: workspace.occurrences.filter((item) =>
                    item.plan.name.includes(search)
                  ),
                },
                next: [],
              };

        if (request.method !== "GET" || !["/user", "/recurring-plans"].includes(path)) {
          return Effect.die(new Error("Unexpected recurring test request"));
        }

        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(result)));
      });

      const apiClient = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(HttpClient.HttpClient, http),
      });

      const registry = AtomRegistry.make();

      const router = createRouter({
        routeTree: createRootRoute({ component: Workspace }),
        context: { apiClient, sessionBinding: "recurring-feature-test" },
        history: createMemoryHistory({ initialEntries: ["/app/recurring"] }),
      });

      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);

      try {
        yield* Effect.tryPromise(() => router.load());
        yield* Effect.tryPromise(() =>
          reactWork(() =>
            root.render(
              createElement(
                RegistryContext.Provider,
                { value: registry },
                createElement(RouterProvider, { router })
              )
            )
          )
        );
        yield* Effect.tryPromise(() =>
          reactAssertion(() => expect(container.textContent).toContain("Ingreso de prueba"))
        );
        yield* check(container);
      } finally {
        yield* Effect.tryPromise(() => reactWork(() => root.unmount()));
        registry.dispose();
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    })
  );

type WorkspaceCheck = Effect.Effect<void, Cause.UnknownError>;

const checkFilters = (presentation: string, container: HTMLElement): WorkspaceCheck =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => click(container, presentation));
    yield* Effect.tryPromise(() => click(container, "Filtros"));
    yield* Effect.tryPromise(() => searchFor(container, "Arriendo"));
    yield* Effect.tryPromise(() => click(container, "Aplicar filtros"));
    yield* Effect.tryPromise(() =>
      reactAssertion(() => {
        expect(container.textContent).toContain("Arriendo de prueba");
        expect(container.textContent).not.toContain("Ingreso de prueba");
        expect(button(container, presentation).getAttribute("aria-pressed")).toBe("true");
      })
    );
    yield* Effect.tryPromise(() => searchFor(container, "Sin coincidencias"));
    yield* Effect.tryPromise(() => click(container, "Aplicar filtros"));
    yield* Effect.tryPromise(() =>
      reactAssertion(() => {
        expect(container.textContent).toContain("Sin resultados para estos filtros");
        expect(button(container, presentation).getAttribute("aria-pressed")).toBe("true");

        Match.value(presentation).pipe(
          Match.when("Calendario", () =>
            expect(container.querySelector('[aria-label="2026-10-31"]')).not.toBeNull()
          ),
          Match.orElse(() => undefined)
        );
      })
    );
    yield* Effect.tryPromise(() => click(container, "Limpiar"));
    yield* Effect.tryPromise(() =>
      reactAssertion(() => {
        expect(container.textContent).toContain("Arriendo de prueba");
        expect(container.textContent).toContain("Ingreso de prueba");
        expect(button(container, presentation).getAttribute("aria-pressed")).toBe("true");
      })
    );
  });

it.each(["Calendario", "Lista", "Todos los recurrentes"])(
  "applying and clearing recurring filters preserves %s and updates its results",
  (presentation) => withWorkspace((container) => checkFilters(presentation, container))
);

const checkEarlierDisclosure = (container: HTMLElement): WorkspaceCheck =>
  Effect.gen(function* () {
    const panel = (): HTMLDetailsElement => {
      const element = container.querySelector('[data-recurring-slot="previous"]');

      if (!Schema.is(Schema.instanceOf(HTMLDetailsElement))(element)) {
        throw Error("Missing earlier-month section");
      }

      return element;
    };

    expect(panel().open).toBe(false);
    yield* Effect.tryPromise(() => reactWork(() => panel().querySelector("summary")?.click()));
    expect(panel().open).toBe(true);
    yield* Effect.tryPromise(() => click(container, "Consultar meses anteriores"));
    yield* Effect.tryPromise(() =>
      reactAssertion(() => {
        expect(panel().querySelector('tr[aria-label*="2026-08-31"]')).not.toBeNull();
        expect(panel().open).toBe(true);
      })
    );
    yield* Effect.tryPromise(() => reactWork(() => panel().querySelector("summary")?.click()));
    expect(panel().open).toBe(false);
  });

it("keeps the requested earlier month open after its fresh occurrences arrive", () =>
  withWorkspace(checkEarlierDisclosure));
