import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BigDecimal, Cause, DateTime, Option, Predicate } from "effect";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionListFeature, TransactionListView } from "./feature";
import { ManualTransactionCapture } from "./manual-capture";
import { makeFidyClient } from "@/transport/client";

const queryKey = (atom: unknown): string => {
  if (!Predicate.isString(atom)) throw new Error("Expected a query key");
  return atom;
};

const queryMocks = vi.hoisted(() => ({
  query: vi.fn((_group: string, operation: string) => operation),
  refresh: vi.fn(),
  dispatch: vi.fn(),
  commandAtom: { name: "capture-transaction" },
  values: new Map<string, unknown>(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomSet: (): typeof queryMocks.dispatch => queryMocks.dispatch,
  useAtomRefresh:
    (atom: unknown): (() => void) =>
    () => {
      queryMocks.refresh(queryKey(atom));
    },
  useAtomValue: (atom: unknown): unknown => queryMocks.values.get(queryKey(atom)),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: (): Readonly<Record<"options", unknown>> => ({
    options: {
      context: {
        apiClient: {
          query: queryMocks.query,
          runtime: { fn: () => () => () => queryMocks.commandAtom },
        },
      },
    },
  }),
}));

const category = {
  id: "24000000-0000-4000-8000-000000000001",
  label: "Restaurantes",
};
const transaction = {
  id: "24000000-0000-4000-8000-000000000002",
  categoryId: category.id,
  notes: Option.none(),
  counterparty: Option.some("El Corral"),
  direction: "outflow" as const,
  money: { amount: BigDecimal.fromStringUnsafe("25000"), currency: "COP" as const },
  occurredAt: DateTime.makeUnsafe("2026-07-20T12:30:00Z"),
};
const seedResources = (): void => {
  queryMocks.values.set(
    "getCurrentUser",
    AsyncResult.success({ data: { locale: "es-CO", timeZone: "America/Bogota" } })
  );
  queryMocks.values.set("listCategories", AsyncResult.success({ data: [category] }));
  queryMocks.values.set("listTransactions", AsyncResult.success({ data: [transaction] }));
};

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  }));
  queryMocks.query.mockClear();
  queryMocks.refresh.mockClear();
  queryMocks.dispatch.mockReset();
  queryMocks.values.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("manual Transaction capture", () => {
  it("defaults to the User's local date across a UTC month boundary", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DateTime.makeUnsafe("2026-09-01T02:00:00Z").epochMilliseconds);
    render(
      <ManualTransactionCapture
        renderForm={(form) => form}
        status="idle"
        onStatus={() => undefined}
        apiClient={makeFidyClient({ apiOrigin: "https://api.test.fidyapp.com" })}
        timeZone="America/Bogota"
        onCreated={() => undefined}
        onCheckHistory={() => undefined}
      />
    );
    expect(screen.getByLabelText("Fecha del movimiento")).toHaveValue("2026-08-31");
  });
});

describe("current-month Transaction list presentation", () => {
  it("renders an accessible loading state", () => {
    render(<TransactionListView state={{ _tag: "Loading" }} />);

    expect(screen.getByLabelText("Cargando transacciones")).toBeVisible();
  });

  it("renders month and zone context in the current ledger", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DateTime.makeUnsafe("2026-07-20T14:00:00Z").epochMilliseconds);
    seedResources();
    render(<TransactionListFeature />);
    expect(screen.getByText("20 de julio de 2026")).toBeVisible();
    const ledger = within(screen.getByLabelText("Tabla de transacciones"));
    expect(ledger.getByRole("button", { name: "Ver transacción El Corral" })).toBeVisible();
    expect(ledger.getByRole("cell", { name: "Restaurantes" })).toBeVisible();
    expect(ledger.getByText("Gasto")).toBeVisible();
    expect(ledger.getByText("COP 25.000,00")).toBeVisible();
    expect(ledger.getByText("20 de julio de 2026")).toBeVisible();
    const summary = within(screen.getByLabelText("Resumen de transacciones"));
    expect(summary.getAllByText("25.000,00")).toHaveLength(4);
    expect(summary.getAllByText("20-07-2026")).toHaveLength(2);
    expect(summary.queryByText(/COP/)).not.toBeInTheDocument();
    expect(summary.queryByText("Del periodo y los filtros seleccionados.")).not.toBeInTheDocument();
    expect(screen.queryByText(/de 1 transacciones del mes/)).not.toBeInTheDocument();
  });
});

describe("current-month Transaction list states", () => {
  it("preserves inflow rows while refreshing", () => {
    seedResources();
    queryMocks.values.set(
      "listTransactions",
      AsyncResult.success({ data: [{ ...transaction, direction: "inflow" }] }, { waiting: true })
    );
    render(<TransactionListFeature />);
    expect(screen.getByText("Actualizando transacciones…")).toBeVisible();
    expect(
      within(screen.getByLabelText("Tabla de transacciones")).getByText("Ingreso")
    ).toBeVisible();
  });
  it("renders the current ledger empty state with its applied zone", () => {
    seedResources();
    queryMocks.values.set("listTransactions", AsyncResult.success({ data: [] }));
    render(<TransactionListFeature />);
    expect(screen.getByText("No hay transacciones para mostrar")).toBeVisible();
    expect(screen.getByText(/America\/Bogota/)).toBeVisible();
  });

  it("renders canonical and boundary errors without exposing their causes", () => {
    const { rerender } = render(
      <TransactionListView
        state={{ _tag: "CanonicalError", onRetry: () => undefined, waiting: false }}
      />
    );

    expect(screen.getByText("No pudimos cargar tus transacciones")).toBeVisible();
    expect(screen.getByText("Intenta de nuevo en unos momentos.")).toBeVisible();

    rerender(
      <TransactionListView
        state={{ _tag: "BoundaryError", onRetry: () => undefined, waiting: true }}
      />
    );
    expect(screen.getByText("No pudimos comunicarnos con Fidy")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reintentando…" })).toBeDisabled();
  });
});

describe("current-month Transaction resources", () => {
  it("distinguishes the idle User query from its initial load", () => {
    queryMocks.values.set("getCurrentUser", AsyncResult.initial());
    const { rerender } = render(<TransactionListFeature />);
    expect(screen.getByText("La consulta aún no se ha iniciado.")).toBeVisible();
    expect(queryMocks.query).toHaveBeenCalledOnce();

    queryMocks.values.set("getCurrentUser", AsyncResult.initial(true));
    rerender(<TransactionListFeature />);
    expect(screen.getByLabelText("Cargando transacciones")).toBeVisible();
  });

  it("renders canonical failures from the User or current-month resources", () => {
    queryMocks.values.set(
      "getCurrentUser",
      AsyncResult.failure(Cause.fail(new Error("canonical failure")))
    );
    const { rerender } = render(<TransactionListFeature />);
    expect(screen.getByText("No pudimos cargar tus transacciones")).toBeVisible();

    queryMocks.values.set("getCurrentUser", AsyncResult.failure(Cause.die("decoder defect")));
    rerender(<TransactionListFeature />);
    expect(screen.getByText("No pudimos comunicarnos con Fidy")).toBeVisible();

    queryMocks.values.set(
      "getCurrentUser",
      AsyncResult.success({ data: { locale: "es-CO", timeZone: "America/Bogota" } })
    );
    queryMocks.values.set(
      "listCategories",
      AsyncResult.failure(Cause.fail(new Error("canonical failure")))
    );
    queryMocks.values.set("listTransactions", AsyncResult.initial());
    rerender(<TransactionListFeature />);
    expect(screen.getByText("No pudimos cargar tus transacciones")).toBeVisible();

    queryMocks.values.set("listCategories", AsyncResult.success({ data: [category] }));
    queryMocks.values.set(
      "listTransactions",
      AsyncResult.failure(Cause.fail(new Error("canonical failure")))
    );
    rerender(<TransactionListFeature />);
    expect(screen.getByText("No pudimos cargar tus transacciones")).toBeVisible();
  });
});

describe("current-month Transaction refreshes", () => {
  it("preserves resources through a User refresh failure and retries the User query", () => {
    const userSuccess = AsyncResult.success({
      data: { locale: "es-CO", timeZone: "America/Bogota" },
    });
    queryMocks.values.set(
      "getCurrentUser",
      AsyncResult.failure(Cause.fail(new Error("User refresh failed")), {
        previousSuccess: Option.some(userSuccess),
        waiting: true,
      })
    );
    queryMocks.values.set("listCategories", AsyncResult.success({ data: [category] }));
    queryMocks.values.set("listTransactions", AsyncResult.success({ data: [transaction] }));

    const { rerender } = render(<TransactionListFeature />);

    expect(screen.getByRole("button", { name: "Ver transacción El Corral" })).toBeVisible();
    expect(screen.getByText("Actualizando perfil de transacciones…")).toBeVisible();
    expect(screen.getByText("No pudimos actualizar tu perfil")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reintentando…" })).toBeDisabled();

    queryMocks.values.set(
      "getCurrentUser",
      AsyncResult.failure(Cause.fail(new Error("User refresh failed")), {
        previousSuccess: Option.some(userSuccess),
      })
    );
    rerender(<TransactionListFeature />);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar actualización del perfil" }));
    expect(queryMocks.refresh).toHaveBeenCalledWith("getCurrentUser");
  });

  it("keeps previous rows through refresh failure and retries the owning queries", () => {
    queryMocks.values.set(
      "getCurrentUser",
      AsyncResult.success({ data: { locale: "es-CO", timeZone: "America/Bogota" } })
    );
    const categoriesSuccess = AsyncResult.success({ data: [category] });
    queryMocks.values.set(
      "listCategories",
      AsyncResult.failure(Cause.fail(new Error("declared refresh failure")), {
        previousSuccess: Option.some(categoriesSuccess),
      })
    );
    queryMocks.values.set("listTransactions", AsyncResult.success({ data: [transaction] }));

    render(<TransactionListFeature />);

    expect(screen.getByRole("button", { name: "Ver transacción El Corral" })).toBeVisible();
    expect(screen.getByText("Mostramos las últimas transacciones disponibles.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar actualización" }));
    expect(queryMocks.refresh).toHaveBeenCalledWith("listCategories");
    expect(queryMocks.refresh).toHaveBeenCalledWith("listTransactions");
  });
});

describe("current-month Transaction resource successes", () => {
  it("renders loading, empty, and ready resource results", () => {
    queryMocks.values.set(
      "getCurrentUser",
      AsyncResult.success({ data: { locale: "es-CO", timeZone: "America/Bogota" } })
    );
    queryMocks.values.set("listCategories", AsyncResult.initial());
    queryMocks.values.set("listTransactions", AsyncResult.initial());
    const { rerender } = render(<TransactionListFeature />);
    expect(screen.getByText("La consulta aún no se ha iniciado.")).toBeVisible();

    queryMocks.values.set("listCategories", AsyncResult.success({ data: [category] }));
    rerender(<TransactionListFeature />);
    expect(screen.getByText("La consulta aún no se ha iniciado.")).toBeVisible();

    queryMocks.values.set("listTransactions", AsyncResult.initial(true));
    rerender(<TransactionListFeature />);
    expect(screen.getByLabelText("Cargando transacciones")).toBeVisible();

    queryMocks.values.set("listCategories", AsyncResult.success({ data: [category] }));
    queryMocks.values.set("listTransactions", AsyncResult.success({ data: [] }));
    rerender(<TransactionListFeature />);
    expect(screen.getByText("No hay transacciones para mostrar")).toBeVisible();

    queryMocks.values.set(
      "listTransactions",
      AsyncResult.success({
        data: [
          {
            ...transaction,
            occurredAt: DateTime.makeUnsafe("2026-08-20T12:30:00Z"),
          },
        ],
      })
    );
    rerender(<TransactionListFeature />);

    expect(screen.getByLabelText("Transacciones del mes")).toBeVisible();
    expect(screen.getByRole("button", { name: "Ver transacción El Corral" })).toBeVisible();
  });
});

describe("transaction workspace", () => {
  it("replaces the summary with details and restores it when the transaction closes", () => {
    queryMocks.values.set(
      "getCurrentUser",
      AsyncResult.success({ data: { locale: "es-CO", timeZone: "America/Bogota" } })
    );
    queryMocks.values.set("listCategories", AsyncResult.success({ data: [category] }));
    queryMocks.values.set(
      "listTransactions",
      AsyncResult.success({ data: [{ ...transaction, revision: 0, notes: Option.none() }] })
    );
    render(<TransactionListFeature />);
    expect(screen.getByRole("heading", { name: "Resumen" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ver transacción El Corral" }));
    expect(screen.getByRole("heading", { name: "Detalle de la transacción" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Resumen" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar detalle" }));
    expect(screen.getByRole("heading", { name: "Resumen" })).toBeVisible();
  });
});

it("summarizes the visible records without combining different currencies", () => {
  queryMocks.values.set(
    "getCurrentUser",
    AsyncResult.success({ data: { locale: "es-CO", timeZone: "America/Bogota" } })
  );
  queryMocks.values.set("listCategories", AsyncResult.success({ data: [category] }));
  queryMocks.values.set(
    "listTransactions",
    AsyncResult.success({
      data: [
        transaction,
        {
          ...transaction,
          id: "income",
          direction: "inflow",
          money: { amount: BigDecimal.fromStringUnsafe("100000"), currency: "COP" },
        },
        {
          ...transaction,
          id: "usd",
          money: { amount: BigDecimal.fromStringUnsafe("10.25"), currency: "USD" },
        },
      ],
    })
  );
  render(<TransactionListFeature />);
  const summary = within(screen.getByLabelText("Resumen de transacciones"));
  expect(summary.getAllByText("COP 100.000,00")).toHaveLength(2);
  expect(summary.getAllByText("USD 10,25").length).toBeGreaterThan(0);
  expect(summary.getByText("Primera transacción")).toBeVisible();
  expect(summary.getByText("Última transacción")).toBeVisible();
});

it("filters the ledger from header tools and lets readers hide a column", () => {
  seedResources();
  render(<TransactionListFeature />);
  fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
  fireEvent.change(screen.getByLabelText("Buscar transacciones"), {
    target: { value: "sin coincidencias" },
  });
  expect(
    screen.queryByRole("button", { name: "Ver transacción El Corral" })
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Buscar transacciones"), { target: { value: "Corral" } });
  expect(screen.getByRole("button", { name: "Ver transacción El Corral" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Fecha" }));
  fireEvent.change(screen.getByLabelText("Filtrar por fecha"), { target: { value: "2026-07-19" } });
  expect(
    screen.queryByRole("button", { name: "Ver transacción El Corral" })
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Filtrar por fecha"), { target: { value: "2026-07-20" } });
  expect(screen.getByRole("button", { name: "Ver transacción El Corral" })).toBeVisible();
  fireEvent.click(screen.getByText("Columnas"));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Categoría" }));
  expect(screen.queryByRole("columnheader", { name: "Categoría" })).not.toBeInTheDocument();
});

const waitForMenuClosed = (trigger: HTMLElement): Promise<void> =>
  waitFor(() => {
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

it("toggles the sort menu, dismisses it with Escape and applies a selection", () => {
  seedResources();
  render(<TransactionListFeature />);
  const trigger = screen.getByRole("button", { name: "Ordenar transacciones" });
  const repetitions = 5;
  for (let attempt = 0; attempt < repetitions; attempt += 1) {
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  }
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape", code: "Escape" });
  return waitForMenuClosed(trigger)
    .then(() => {
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Contraparte Z–A" }));
      return waitForMenuClosed(trigger);
    })
    .then(() => expect(trigger).toHaveTextContent("Contraparte Z–A"));
});

it("lets readers clear filters even after their input is hidden", () => {
  seedResources();
  render(<TransactionListFeature />);
  fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
  fireEvent.change(screen.getByLabelText("Buscar transacciones"), {
    target: { value: "no match" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
  expect(screen.queryByLabelText("Buscar transacciones")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Ver transacción El Corral" })
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
  expect(screen.getByRole("button", { name: "Ver transacción El Corral" })).toBeVisible();
});

it("combines filters, keeps the summary in sync and sorts the visible rows", () => {
  seedResources();
  const market = { id: "market", label: "Mercado" };
  queryMocks.values.set("listCategories", AsyncResult.success({ data: [category, market] }));
  queryMocks.values.set(
    "listTransactions",
    AsyncResult.success({
      data: [
        transaction,
        {
          ...transaction,
          id: "market-record",
          categoryId: market.id,
          counterparty: Option.some("Éxito"),
        },
        {
          ...transaction,
          id: "income-record",
          direction: "inflow",
          counterparty: Option.some("Acme"),
        },
      ],
    })
  );
  render(<TransactionListFeature />);
  fireEvent.click(screen.getByRole("button", { name: "Ordenar transacciones" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Contraparte Z–A" }));
  return waitForMenuClosed(screen.getByRole("button", { name: "Ordenar transacciones" })).then(
    () => {
      const ledger = within(screen.getByLabelText("Transacciones del mes"));
      expect(
        ledger
          .getAllByRole("button", { name: /^Ver transacción/ })
          .map((button) => button.getAttribute("aria-label"))
      ).toEqual(["Ver transacción Éxito", "Ver transacción El Corral", "Ver transacción Acme"]);
      fireEvent.change(screen.getByLabelText("Filtrar por tipo"), { target: { value: "outflow" } });
      fireEvent.click(screen.getByRole("button", { name: "Filtros" }));
      fireEvent.change(screen.getByLabelText("Filtrar por categoría"), {
        target: { value: market.id },
      });
      expect(ledger.getAllByRole("button", { name: /^Ver transacción/ })).toHaveLength(1);
      expect(
        screen.queryByRole("button", { name: "Ver transacción Acme" })
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Resumen de transacciones")).toHaveTextContent(
        "Total de transacciones1"
      );
      fireEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
      expect(ledger.getAllByRole("button", { name: /^Ver transacción/ })).toHaveLength(3);
    }
  );
});
