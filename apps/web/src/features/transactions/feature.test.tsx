import { cleanup, render, screen, within } from "@testing-library/react";
import { BigDecimal, Cause, DateTime, Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionListFeature, TransactionListView } from "./feature";
import type { TransactionListRow } from "./presentation";

const queryMocks = vi.hoisted(() => ({
  query: vi.fn((_group: string, operation: string) => operation),
  values: new Map<string, unknown>(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string): unknown => queryMocks.values.get(atom),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: (): Readonly<Record<"options", unknown>> => ({
    options: { context: { apiClient: { query: queryMocks.query } } },
  }),
}));

const period: Readonly<{ monthLabel: string; timeZone: string }> = {
  monthLabel: "julio de 2026",
  timeZone: "America/Bogota",
};
const category = {
  id: "24000000-0000-4000-8000-000000000001",
  label: "Restaurantes",
};
const transaction = {
  id: "24000000-0000-4000-8000-000000000002",
  categoryId: category.id,
  counterparty: Option.some("El Corral"),
  direction: "outflow" as const,
  money: { amount: BigDecimal.fromStringUnsafe("25000"), currency: "COP" as const },
  occurredAt: DateTime.makeUnsafe("2026-07-20T12:30:00Z"),
};
const row: TransactionListRow = {
  id: transaction.id,
  categoryLabel: category.label,
  counterpartyLabel: "El Corral",
  direction: transaction.direction,
  transactionTypeLabel: "Gasto",
  moneyText: "COP 25.000,00",
  occurredOnText: "20-07-2026",
};

beforeEach(() => {
  queryMocks.query.mockClear();
  queryMocks.values.clear();
});
afterEach(cleanup);

describe("current-month Transaction list presentation", () => {
  it("renders an accessible loading state", () => {
    render(<TransactionListView state={{ _tag: "Loading" }} />);

    expect(screen.getByLabelText("Cargando transacciones")).toBeVisible();
  });

  it("renders month and zone context with desktop and mobile Transaction rows", () => {
    render(<TransactionListView state={{ _tag: "Ready", period, rows: [row] }} />);

    expect(screen.getByText("julio de 2026")).toBeVisible();
    expect(screen.getByText("America/Bogota")).toBeVisible();

    const desktop = within(screen.getByLabelText("Tabla de transacciones"));
    expect(desktop.getByText("El Corral")).toBeVisible();
    expect(desktop.getByText("Restaurantes")).toBeVisible();
    expect(desktop.getByText("Tipo")).toBeVisible();
    expect(desktop.getByText("Gasto")).toBeVisible();
    expect(desktop.getByText("COP 25.000,00")).toBeVisible();
    expect(desktop.getByText("20-07-2026")).toBeVisible();

    const mobile = within(screen.getByLabelText("Lista móvil de transacciones"));
    expect(mobile.getByText("El Corral")).toBeVisible();
    expect(mobile.getByText("Gasto")).toBeVisible();
  });

  it("renders the current-month empty state with its applied zone", () => {
    render(<TransactionListView state={{ _tag: "Empty", period }} />);

    expect(screen.getByText("Aún no hay transacciones este mes")).toBeVisible();
    expect(screen.getByText("America/Bogota")).toBeVisible();
  });

  it("renders a canonical error without exposing its cause", () => {
    render(<TransactionListView state={{ _tag: "CanonicalError" }} />);

    expect(screen.getByText("No pudimos cargar tus transacciones")).toBeVisible();
    expect(screen.getByText("Intenta de nuevo en unos momentos.")).toBeVisible();
  });
});

describe("current-month Transaction resources", () => {
  it("loads the User before requesting current-month resources", () => {
    queryMocks.values.set("getCurrentUser", AsyncResult.initial());

    render(<TransactionListFeature />);

    expect(screen.getByLabelText("Cargando transacciones")).toBeVisible();
    expect(queryMocks.query).toHaveBeenCalledOnce();
  });

  it("renders canonical failures from the User or current-month resources", () => {
    queryMocks.values.set(
      "getCurrentUser",
      AsyncResult.failure(Cause.fail(new Error("canonical failure")))
    );
    const { rerender } = render(<TransactionListFeature />);
    expect(screen.getByText("No pudimos cargar tus transacciones")).toBeVisible();

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
    expect(screen.getByLabelText("Cargando transacciones")).toBeVisible();

    queryMocks.values.set("listCategories", AsyncResult.success({ data: [category] }));
    queryMocks.values.set("listTransactions", AsyncResult.success({ data: [] }));
    rerender(<TransactionListFeature />);
    expect(screen.getByText("Aún no hay transacciones este mes")).toBeVisible();

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
    expect(screen.getAllByText("El Corral")).toHaveLength(2);
  });
});
