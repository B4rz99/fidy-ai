import { RegistryContext } from "@effect/atom-react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { type Cause, DateTime, Deferred, Effect, Layer, Option, Predicate, Schema } from "effect";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { BudgetScreen } from "@/features/budgets/screen";

const category = {
  id: "24000000-0000-4000-8000-000000000102",
  label: "Restaurantes",
  icon: "utensils",
  kind: "expense",
  isSystem: true,
};

type WireBudget = Readonly<{
  id: string;
  categoryId: string;
  cap: Readonly<{ amount: string; currency: string }>;
  groupName: string;
  createdAt: string;
  updatedAt: string;
}>;

const budget = (amount: string): WireBudget => ({
  id: "24000000-0000-4000-8000-000000000101",
  categoryId: category.id,
  cap: { amount, currency: "COP" },
  groupName: "Alimentación",
  createdAt: "2026-11-01T05:00:00.000Z",
  updatedAt: "2026-11-01T05:00:00.000Z",
});

const profile = {
  id: "10000000-0000-4000-8000-000000000001",
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  createdAt: "2026-01-01T00:00:00.000Z",
  trialPeriod: { startedAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-01-08T00:00:00.000Z" },
};

type TargetChange = "same" | "deleted" | "reassigned";

const validationFailedBody =
  '{"_tag":"ValidationFailed","error":{"code":"validation_failed","message":"Rejected","fields":[]},"next":[]}';

const report = ({
  month,
  amount,
  secondCategory,
  targetChange,
}: Readonly<{
  month: string;
  amount: string;
  secondCategory: boolean;
  targetChange: TargetChange;
}>): Response => {
  const november = month === "2026-11";
  const from = DateTime.makeUnsafe(`${month}-01T05:00:00Z`);

  const period = {
    from: DateTime.formatIso(from),
    to: DateTime.formatIso(DateTime.add(from, { months: 1 })),
    timeZone: "America/Bogota",
  };

  const secondBudget = {
    ...budget("50000"),
    id: "24000000-0000-4000-8000-000000000103",
    categoryId: "24000000-0000-4000-8000-000000000104",
  };

  const initialBudgets = november
    ? [budget(amount)].concat(secondCategory ? [secondBudget] : [])
    : [];

  const budgets = initialBudgets
    .filter((value) => targetChange !== "deleted" || value.categoryId !== category.id)
    .map((value) =>
      targetChange === "reassigned" && value.categoryId === category.id
        ? { ...value, groupName: "Otro grupo" }
        : value
    );

  return Response.json({
    data: {
      period,
      initialized: true,
      budgets,
      statuses: budgets.map((value) => ({
        type: "under",
        budget: value,
        period,
        spent: { amount: "0", currency: "COP" },
        remaining: value.cap,
      })),
      unbudgetedExpenses: [],
      cashFlow: { income: [], expenses: [] },
    },
    next: [],
  });
};

const work = (run: () => void): Promise<void> => Promise.resolve(act(() => Promise.resolve(run())));

const check = (run: () => void): Promise<void> => Promise.resolve(act(() => vi.waitFor(run)));

const button = (container: HTMLElement, label: string): HTMLButtonElement => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label
  );

  if (found === undefined) {
    throw new Error(`Missing ${label}`);
  }

  return found;
};

const monthTrigger = (container: HTMLElement): HTMLButtonElement => {
  const found = container.querySelector<HTMLButtonElement>('[data-recurring-slot="month-picker"]');

  if (found === null) {
    throw new Error("Missing month picker");
  }

  return found;
};

const monthChoice = (label: string): HTMLButtonElement => {
  const found = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  if (found === null) {
    throw new Error(`Missing ${label}`);
  }

  return found;
};

const chooseMonth = (container: HTMLElement, label: string): Promise<void> =>
  work(() => monthTrigger(container).click())
    .then(() => check(() => monthChoice(label)))
    .then(() => work(() => monthChoice(label).click()));

const navigate = (container: HTMLElement, control: string): Promise<void> =>
  control === "Hoy"
    ? work(() => button(container, "Hoy").focus()).then(() =>
        work(() => button(container, "Hoy").click())
      )
    : work(() => monthTrigger(container).focus()).then(() => chooseMonth(container, control));

const input = (container: HTMLElement): HTMLInputElement => {
  const found = container.querySelector<HTMLInputElement>(
    'input[aria-label="Presupuesto de Restaurantes (COP)"]'
  );

  if (found === null) {
    throw new Error(`Missing Budget input: ${container.innerHTML}`);
  }

  return found;
};

type TestView = Readonly<{
  container: HTMLDivElement;
  settle: (outcome?: "saved" | "uncertain" | "failed", committed?: boolean) => Promise<void>;
  writes: ReadonlyArray<unknown>;
  changeTarget: (change: TargetChange) => void;
  close: () => Promise<void>;
}>;

const setup = (secondCategory = false): Effect.Effect<TestView, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => import("@/features/budgets/dev-preview"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DateTime.makeUnsafe("2026-12-17T12:00:00Z").epochMilliseconds);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      }
    );
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    }));
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const services = yield* Effect.context<never>();
    let reply = Deferred.makeUnsafe<Response>();
    const writes: unknown[] = [];
    let amount = "100000";
    let targetChange: TargetChange = "same";

    const http = HttpClient.make((request) => {
      if (request.method === "PUT") {
        if (Predicate.isTagged(request.body, "Uint8Array")) {
          writes.push(JSON.parse(new TextDecoder().decode(request.body.body)));
        }

        return Effect.map(Deferred.await(reply), (value) =>
          HttpClientResponse.fromWeb(request, value)
        );
      }

      const secondCategoryEntry = {
        ...category,
        id: "24000000-0000-4000-8000-000000000104",
        label: "Mercado",
      };

      const response = Effect.succeed(
        request.url.includes("budget-status")
          ? report({
              month: Option.getOrElse(
                UrlParams.getFirst(request.urlParams, "month"),
                () => "2026-11"
              ),
              amount,
              secondCategory,
              targetChange,
            })
          : Response.json({
              data: request.url.endsWith("categories")
                ? [category].concat(secondCategory ? [secondCategoryEntry] : [])
                : profile,
              next: [],
            })
      );

      return Effect.map(response, (value) => HttpClientResponse.fromWeb(request, value));
    });

    const apiClient = makeFidyClient({
      apiOrigin: "https://api.test.fidyapp.com",
      httpClient: Layer.succeed(HttpClient.HttpClient, http),
    });

    const registry = AtomRegistry.make();
    const parent = createRootRoute();
    const screenProps = { children: null };

    const route = createRoute({
      getParentRoute: () => parent,
      path: "/app/budgets",
      component: () => createElement(BudgetScreen, screenProps),
      validateSearch: (search) => ({
        month: Predicate.isString(search.month) ? search.month : "2026-11",
      }),
    });

    const router = createRouter({
      routeTree: parent.addChildren([route]),
      context: { apiClient },
      history: createMemoryHistory({ initialEntries: ["/app/budgets?month=2026-11"] }),
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    yield* Effect.tryPromise(() => router.load());
    yield* Effect.tryPromise(() =>
      work(() =>
        root.render(
          createElement(
            RegistryContext.Provider,
            { value: registry },
            createElement(RouterProvider, { router })
          )
        )
      )
    );

    return {
      container,
      writes,
      changeTarget: (change) => {
        targetChange = change;
      },
      settle: (outcome = "saved", committed = outcome === "saved"): Promise<void> => {
        const written = Schema.decodeUnknownSync(
          Schema.Struct({ month: Schema.String, cap: Schema.Struct({ amount: Schema.String }) })
        )(writes.at(-1));

        if (committed && written.month === "2026-11") {
          amount = written.cap.amount;
        }

        let response = Response.json({ data: budget(written.cap.amount), next: [] });

        if (outcome === "uncertain") {
          response = Response.json({});
        }

        if (outcome === "failed") {
          response = new Response(validationFailedBody, {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        const waiting = reply;
        reply = Deferred.makeUnsafe<Response>();

        return Promise.resolve(
          act(() =>
            Effect.runPromiseWith(services)(Deferred.succeed(waiting, response)).then(
              () => undefined
            )
          )
        );
      },
      close: (): Promise<void> =>
        work(() => {
          root.unmount();
          container.remove();
          registry.dispose();
          vi.useRealTimers();
          vi.restoreAllMocks();
          vi.unstubAllGlobals();
        }),
    };
  });

it.each([
  ["Octubre de 2026", "Octubre de 2026"],
  ["Diciembre de 2026", "Diciembre de 2026"],
  ["Hoy", "Diciembre de 2026"],
])(
  "choosing %s saves the inline Budget in November and opens the requested month",
  (control, destination) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const view = yield* setup();

        try {
          yield* Effect.tryPromise(() =>
            check(() => expect(input(view.container).value).toBe("100000"))
          );
          const field = input(view.container);
          yield* Effect.tryPromise(() =>
            work(() => {
              field.focus();
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
                field,
                "190000"
              );
              field.dispatchEvent(new Event("input", { bubbles: true }));
            })
          );
          yield* Effect.tryPromise(() => navigate(view.container, control));
          expect(view.writes).toEqual([
            expect.objectContaining({
              month: "2026-11",
              cap: { amount: "190000", currency: "COP" },
            }),
          ]);
          yield* Effect.tryPromise(() => view.settle());
          yield* Effect.tryPromise(() =>
            check(() => expect(view.container.textContent).toContain(destination))
          );
        } finally {
          yield* Effect.tryPromise(view.close);
        }
      })
    )
);

it.each([false, true])(
  "checking an uncertain save retains the draft and reconciles before continuing: committed %s",
  (committed) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const view = yield* setup();

        try {
          yield* Effect.tryPromise(() =>
            check(() => expect(input(view.container).value).toBe("100000"))
          );
          yield* Effect.tryPromise(() => editAmount(view.container, "190000"));
          yield* Effect.tryPromise(() => work(() => monthTrigger(view.container).focus()));
          yield* Effect.tryPromise(() => chooseMonth(view.container, "Octubre de 2026"));
          yield* Effect.tryPromise(() => view.settle("uncertain", committed));
          yield* Effect.tryPromise(() =>
            check(() =>
              expect(view.container.textContent).toContain("No pudimos confirmar el guardado")
            )
          );
          expect(view.container.textContent).toContain("Noviembre de 2026");
          expect(input(view.container).value).toBe("190000");
          yield* Effect.tryPromise(() => work(() => button(view.container, "Actualizar").click()));
          yield* Effect.tryPromise(() =>
            check(() => expect(input(view.container).disabled).toBe(false))
          );
          expect(input(view.container).value).toBe("190000");
          expect(view.writes).toHaveLength(1);
          yield* Effect.tryPromise(() => chooseMonth(view.container, "Octubre de 2026"));

          yield* committed
            ? Effect.void
            : Effect.gen(function* () {
                expect(view.container.textContent).toContain("Noviembre de 2026");
                expect(view.writes).toHaveLength(2);
                yield* Effect.tryPromise(() => view.settle());
              });

          yield* Effect.tryPromise(() =>
            check(() => expect(view.container.textContent).toContain("Octubre de 2026"))
          );
          expect(view.writes).toHaveLength(committed ? 1 : 2);
        } finally {
          yield* Effect.tryPromise(view.close);
        }
      })
    )
);

const editAmount = (container: HTMLElement, amount: string): Promise<void> =>
  work(() => {
    const field = input(container);
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, amount);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

it("a refused inline save keeps its draft and a second month choice retries before navigating", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const view = yield* setup();

      try {
        yield* Effect.tryPromise(() =>
          check(() => expect(input(view.container).value).toBe("100000"))
        );
        yield* Effect.tryPromise(() => editAmount(view.container, "190000"));
        yield* Effect.tryPromise(() => work(() => monthTrigger(view.container).focus()));
        yield* Effect.tryPromise(() => chooseMonth(view.container, "Octubre de 2026"));
        yield* Effect.tryPromise(() => view.settle("failed"));
        yield* Effect.tryPromise(() =>
          check(() => expect(view.container.textContent).toContain("No se pudo guardar"))
        );
        expect(input(view.container).value).toBe("190000");
        expect(view.container.textContent).toContain("Noviembre de 2026");
        yield* Effect.tryPromise(() => chooseMonth(view.container, "Octubre de 2026"));
        expect(view.container.textContent).toContain("Noviembre de 2026");
        expect(view.writes).toHaveLength(2);
        yield* Effect.tryPromise(() => view.settle());
        yield* Effect.tryPromise(() =>
          check(() => expect(view.container.textContent).toContain("Octubre de 2026"))
        );
      } finally {
        yield* Effect.tryPromise(view.close);
      }
    })
  ));

it("an invalid inline amount does not leave a navigation action for a later unrelated save", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const view = yield* setup();

      try {
        yield* Effect.tryPromise(() =>
          check(() => expect(input(view.container).value).toBe("100000"))
        );
        yield* Effect.tryPromise(() => editAmount(view.container, "0"));
        yield* Effect.tryPromise(() => work(() => monthTrigger(view.container).focus()));
        yield* Effect.tryPromise(() => chooseMonth(view.container, "Octubre de 2026"));
        expect(view.container.textContent).toContain("Noviembre de 2026");
        expect(input(view.container).getAttribute("aria-invalid")).toBe("true");
        expect(view.writes).toHaveLength(0);
        yield* Effect.tryPromise(() => editAmount(view.container, "190000"));
        yield* Effect.tryPromise(() => work(() => button(view.container, "Actualizar").focus()));
        yield* Effect.tryPromise(() => view.settle());
        yield* Effect.tryPromise(() =>
          check(() => expect(view.container.textContent).toContain("Presupuesto guardado"))
        );
        expect(view.container.textContent).toContain("Noviembre de 2026");
      } finally {
        yield* Effect.tryPromise(view.close);
      }
    })
  ));

it("an unresolved inline Budget keeps its draft while other Category edits wait for recovery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const view = yield* setup(true);

      try {
        yield* Effect.tryPromise(() =>
          check(() => expect(input(view.container).value).toBe("100000"))
        );
        yield* Effect.tryPromise(() => editAmount(view.container, "190000"));
        yield* Effect.tryPromise(() => work(() => monthTrigger(view.container).focus()));
        yield* Effect.tryPromise(() => chooseMonth(view.container, "Octubre de 2026"));
        yield* Effect.tryPromise(() => view.settle("failed"));
        yield* Effect.tryPromise(() =>
          check(() => expect(view.container.textContent).toContain("No se pudo guardar"))
        );
        expect(input(view.container).value).toBe("190000");
        expect(
          view.container.querySelector<HTMLInputElement>(
            'input[aria-label="Presupuesto de Mercado (COP)"]'
          )?.disabled
        ).toBe(true);
      } finally {
        yield* Effect.tryPromise(view.close);
      }
    })
  ));

it.each(["deleted", "reassigned"] as const)(
  "a canonical reread exposes recovery for an inline Budget that was %s",
  (change) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const view = yield* setup(true);

        try {
          yield* Effect.tryPromise(() =>
            check(() => expect(input(view.container).value).toBe("100000"))
          );
          yield* Effect.tryPromise(() => editAmount(view.container, "190000"));
          yield* Effect.tryPromise(() => work(() => monthTrigger(view.container).focus()));
          yield* Effect.tryPromise(() => chooseMonth(view.container, "Octubre de 2026"));
          yield* Effect.tryPromise(() => view.settle("uncertain", false));
          yield* Effect.tryPromise(() =>
            check(() =>
              expect(view.container.textContent).toContain("No pudimos confirmar el guardado")
            )
          );
          view.changeTarget(change);
          yield* Effect.tryPromise(() => work(() => button(view.container, "Actualizar").click()));
          yield* Effect.tryPromise(() =>
            check(() =>
              expect(
                view.container.querySelector<HTMLInputElement>(
                  'input[aria-label="Edición pendiente de Restaurantes (COP)"]'
                )?.value
              ).toBe("190000")
            )
          );
          expect(view.container.textContent).not.toContain("Presupuesto guardado");
          yield* Effect.tryPromise(() =>
            work(() => button(view.container, "Descartar edición").click())
          );
          yield* Effect.tryPromise(() =>
            check(() =>
              expect(
                view.container.querySelector<HTMLInputElement>(
                  'input[aria-label="Presupuesto de Mercado (COP)"]'
                )?.disabled
              ).toBe(false)
            )
          );
          yield* Effect.tryPromise(() => chooseMonth(view.container, "Octubre de 2026"));
          yield* Effect.tryPromise(() =>
            check(() => expect(view.container.textContent).toContain("Octubre de 2026"))
          );
          expect(view.writes).toHaveLength(1);
        } finally {
          yield* Effect.tryPromise(view.close);
        }
      })
    )
);

it("names each budget assignment action after the Category it assigns", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const view = yield* setup();

      try {
        yield* Effect.tryPromise(() =>
          check(() => expect(input(view.container).value).toBe("100000"))
        );
        yield* Effect.tryPromise(() => chooseMonth(view.container, "Octubre de 2026"));
        yield* Effect.tryPromise(() =>
          check(() =>
            expect(button(view.container, "Asignar presupuesto a Restaurantes").textContent).toBe(
              "Asignar presupuesto"
            )
          )
        );
      } finally {
        yield* Effect.tryPromise(view.close);
      }
    })
  ));
