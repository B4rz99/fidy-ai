import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Option, Schema } from "effect";
import { PATActivity } from "@/transport/client";
import { PATActivityPicker, PATActivityResults } from "./activity-view";

afterEach(cleanup);

const history = Schema.decodeSync(Schema.toCodecJson(PATActivity))({
  pat: {
    shortId: "created1",
    recipientLabel: "Mi agente",
    scopes: ["read"],
    createdAt: "2026-10-01T12:00:00Z",
    lastUsedAt: null,
    expiresAt: "2026-10-08T12:00:00Z",
    revokedAt: null,
  },
  entries: [
    {
      operation: "categories.listCategories",
      outcome: "rejected",
      occurredAt: "2026-10-07T12:00:00Z",
    },
  ],
  hasMore: true,
  retainedSince: "2025-10-07T12:00:00Z",
});

it("selects a safe PAT code and explains the bounded retained results in UTC", () => {
  const select = vi.fn();
  render(<PATActivityPicker onSelect={select} />);
  fireEvent.change(screen.getByLabelText("Código del token"), { target: { value: "created1" } });
  fireEvent.click(screen.getByRole("button", { name: "Consultar actividad" }));
  expect(select).toHaveBeenCalledWith("created1");
  render(
    <PATActivityResults
      state={{ _tag: "Ready", value: history, waiting: false, refreshFailure: Option.none() }}
      onRetry={vi.fn()}
    />
  );
  expect(screen.getByText("categories.listCategories")).toBeVisible();
  expect(screen.getByText(/Rechazada/, { selector: "li" })).toBeVisible();
  expect(screen.getByText("2026-10-07T12:00:00.000Z")).toHaveAttribute(
    "dateTime",
    "2026-10-07T12:00:00.000Z"
  );
  expect(screen.getByText(/Hay más actividad retenida/)).toBeVisible();
  expect(
    screen.getByText(/El historial no demuestra que el token nunca se haya usado/)
  ).toBeVisible();
});

it("refuses bearer-shaped input and reports honest empty, loading, and query failure states", () => {
  const select = vi.fn();
  const retry = vi.fn();
  const picker = render(<PATActivityPicker onSelect={select} />);
  fireEvent.change(screen.getByLabelText("Código del token"), {
    target: { value: "fin_created1_private-material" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Consultar actividad" }));
  expect(select).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("Ingresa un código válido");
  picker.unmount();
  const result = render(
    <PATActivityResults state={{ _tag: "Initial", waiting: true }} onRetry={retry} />
  );
  expect(screen.getByText("Cargando actividad…")).toBeVisible();
  result.rerender(
    <PATActivityResults
      state={{
        _tag: "Ready",
        value: { ...history, entries: [], hasMore: false },
        waiting: false,
        refreshFailure: Option.none(),
      }}
      onRetry={retry}
    />
  );
  expect(screen.getByText("No hay actividad retenida para este token.")).toBeVisible();
  expect(screen.queryByText(/Hay más actividad retenida/)).not.toBeInTheDocument();
  result.rerender(
    <PATActivityResults
      state={{ _tag: "Failure", failure: { _tag: "BoundaryFailure" }, waiting: false }}
      onRetry={retry}
    />
  );
  expect(screen.getByText("No pudimos consultar la actividad")).toBeVisible();
  expect(screen.queryByText("No hay actividad retenida para este token.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("preserves the last activity during refresh failure and offers an explicit retry", () => {
  const retry = vi.fn();
  render(
    <PATActivityResults
      state={{
        _tag: "Ready",
        value: history,
        waiting: false,
        refreshFailure: Option.some({ _tag: "BoundaryFailure" }),
      }}
      onRetry={retry}
    />
  );
  expect(screen.getByText("categories.listCategories")).toBeVisible();
  expect(screen.getByText("Mostramos la última actividad disponible.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Reintentar actualización" }));
  expect(retry).toHaveBeenCalledOnce();
});
