// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { type Cause, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { IanaTimeZone, makeFidyClient } from "@/transport/client";
import { RecurringFeature } from "./feature";
import type { PlanInput } from "./model";
import { PlanForm } from "./plan-form";

const plans = [
  {
    id: "24000000-0000-4000-8000-000000017231",
    name: "Arriendo de prueba",
    kind: "expense",
  },
  {
    id: "24000000-0000-4000-8000-000000017232",
    name: "Ingreso de prueba",
    kind: "income",
  },
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

    if (!(input instanceof HTMLInputElement)) {
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
      const parent = createRootRoute({ component: Workspace });

      const router = createRouter({
        routeTree: parent.addChildren([
          createRoute({ getParentRoute: () => parent, path: "/app/recurring" }),
        ]),
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

const filteredScope =
  "Resumen filtrado: solo incluye los recurrentes que coinciden con los filtros.";

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

        if (presentation !== "Todos los recurrentes") {
          expect(container.textContent).toContain(filteredScope);
          expect(container.textContent).toContain("Sin recurrentes que coincidan con los filtros");
          expect(container.textContent).not.toContain("Sin recurrentes este mes");
        }
      })
    );
    yield* Effect.tryPromise(() => searchFor(container, "Sin coincidencias"));
    yield* Effect.tryPromise(() => click(container, "Aplicar filtros"));
    yield* Effect.tryPromise(() =>
      reactAssertion(() => {
        expect(container.textContent).toContain("Sin resultados para estos filtros");
        expect(button(container, presentation).getAttribute("aria-pressed")).toBe("true");

        if (presentation === "Calendario") {
          expect(container.querySelector('[aria-label="2026-10-31"]')).not.toBeNull();
        }
      })
    );
    yield* Effect.tryPromise(() => click(container, "Limpiar"));
    yield* Effect.tryPromise(() =>
      reactAssertion(() => {
        expect(container.textContent).toContain("Arriendo de prueba");
        expect(container.textContent).toContain("Ingreso de prueba");
        expect(button(container, presentation).getAttribute("aria-pressed")).toBe("true");
        expect(container.textContent).not.toContain(filteredScope);

        if (presentation !== "Todos los recurrentes") {
          expect(container.textContent).toContain("Sin recurrentes este mes");
        }
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

      if (!(element instanceof HTMLDetailsElement)) throw Error("Missing earlier-month section");

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

const renderForm = (
  initial: Partial<PlanInput>
): Readonly<{
  container: HTMLElement;
  onSubmit: ReturnType<typeof vi.fn>;
}> => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const onSubmit = vi.fn();
  act(() =>
    createRoot(container).render(
      createElement(PlanForm, {
        initial: {
          name: "Arriendo de prueba",
          timeZone: IanaTimeZone.make("America/Bogota"),
          firstDate: "2026-11-02",
          ...initial,
        },
        categories: [],
        disabled: false,
        onSubmit,
      })
    )
  );

  return { container, onSubmit };
};

const save = (container: HTMLElement): void =>
  act(() => container.querySelector("form")?.requestSubmit());

const described = (element: unknown): string => {
  const id = element instanceof Element ? element.getAttribute("aria-describedby") : "";

  return document.getElementById(id ?? "")?.textContent ?? "";
};

const typeInto = (input: HTMLInputElement, text: string): void =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

it("explains an out-of-range twice-monthly day at its field without the card-payment rule", () => {
  const { container, onSubmit } = renderForm({
    frequency: "twice-monthly",
    monthDays: [15, "last"],
  });

  const firstDay = container.querySelector<HTMLInputElement>("#recurring-day1");

  if (firstDay === null) throw new Error("Missing first day");
  typeInto(firstDay, "32");
  save(container);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(firstDay);
  expect(firstDay.getAttribute("aria-invalid")).toBe("true");
  expect(described(firstDay)).toBe("Escribe un día del 1 al 31 o «último».");
  expect(firstDay.value).toBe("32");
  expect(container.textContent).not.toContain("tarjeta debe");
  typeInto(firstDay, "1");
  expect(firstDay.hasAttribute("aria-invalid")).toBe(false);
});

it("asks for two different twice-monthly days", () => {
  const { container, onSubmit } = renderForm({
    frequency: "twice-monthly",
    monthDays: [15, 15],
  });

  save(container);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(described(document.activeElement)).toBe("Elige un día diferente del primero.");
  expect(document.activeElement?.id).toBe("recurring-day2");
});

it("identifies an end date that precedes the first date", () => {
  const { container, onSubmit } = renderForm({ endDate: "2026-11-01" });
  save(container);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(document.activeElement?.id).toBe("recurring-endDate");
  expect(described(document.activeElement)).toBe(
    "La fecha final debe ser igual o posterior a la primera fecha."
  );
});

it("explains the card-payment rule only for card payments that are not transfers", () => {
  const { container, onSubmit } = renderForm({
    cardPayment: true,
    kind: "expense",
  });

  save(container);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(document.activeElement?.id).toBe("recurring-cardPayment");
  expect(described(document.activeElement)).toBe(
    "Un pago de tarjeta debe tener el tipo Transferencia."
  );
});

it("submits a valid twice-monthly plan with its last-day choice", () => {
  const { container, onSubmit } = renderForm({
    frequency: "twice-monthly",
    monthDays: [15, "last"],
  });

  save(container);
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      frequency: "twice-monthly",
      monthDays: [15, "last"],
    })
  );
});

const panelElement = (): HTMLElement => {
  const panel = document.querySelector('[role="dialog"]');

  if (!(panel instanceof HTMLElement)) throw new Error("Missing recurring panel");

  return panel;
};

const panelInput = (id: string): HTMLInputElement => {
  const input = panelElement().querySelector(`#${id}`);

  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing ${id}`);

  return input;
};

const nameField = (): HTMLInputElement => panelInput("recurring-name");

const expectBlankCreation = (): Promise<void> =>
  reactAssertion(() => {
    expect(nameField().value).toBe("");
    expect(panelElement().textContent).not.toContain("Borrador sin guardar");
  });

const openOccurrence = (container: HTMLElement): Promise<void> =>
  reactWork(() =>
    Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent.includes("Ingreso de prueba"))
      ?.click()
  );

const openCreation = (container: HTMLElement): WorkspaceCheck =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => click(container, "Nuevo recurrente"));
    yield* Effect.tryPromise(() => reactAssertion(() => nameField()));
  });

const leaveDraft = (container: HTMLElement, name: string): WorkspaceCheck =>
  Effect.gen(function* () {
    yield* openCreation(container);

    if (name !== "") {
      typeInto(nameField(), name);
      typeInto(panelInput("recurring-counterparty"), "Inmobiliaria Sur");
    }

    yield* Effect.tryPromise(() => openOccurrence(container));
    yield* Effect.tryPromise(() =>
      reactAssertion(() =>
        expect(panelElement().querySelector("h2")?.textContent).toBe("Ingreso de prueba")
      )
    );
    yield* openCreation(container);
  });

it("keeps a modified creation draft when another occurrence opens until it is discarded", () =>
  withWorkspace((container) =>
    Effect.gen(function* () {
      yield* leaveDraft(container, "Arriendo oficina");
      expect(nameField().value).toBe("Arriendo oficina");
      expect(panelInput("recurring-counterparty").value).toBe("Inmobiliaria Sur");
      expect(panelElement().textContent).toContain("Borrador sin guardar");
      yield* Effect.tryPromise(() => click(panelElement(), "Descartar borrador"));
      yield* Effect.tryPromise(expectBlankCreation);
    })
  ));

it("opens a blank creation form after an untouched form or an explicit cancellation", () =>
  withWorkspace((container) =>
    Effect.gen(function* () {
      yield* leaveDraft(container, "");
      expect(panelElement().textContent).not.toContain("Borrador sin guardar");
      typeInto(nameField(), "Arriendo oficina");
      yield* Effect.tryPromise(() => click(panelElement(), "Cancelar"));
      yield* openCreation(container);
      yield* Effect.tryPromise(expectBlankCreation);
    })
  ));
