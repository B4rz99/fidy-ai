import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateTime, Duration, Option } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  PATId,
  PATRecipientLabel,
  PATScopes,
  TokenBearer,
  TokenShortId,
  recipientLabelLimit,
} from "@/transport/client";
import { bearerRevealLifetime } from "./policy";
import { type IssueManualPATCommand, ManualPATView } from "./view";

const bearer = TokenBearer.make("fin_created1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const createdAt = DateTime.makeUnsafe("2026-08-10T12:00:00Z");
const issued = {
  pat: {
    _tag: "PAT" as const,
    id: PATId.make("f1d1a000-0000-4000-8000-000000000248"),
    shortId: TokenShortId.make("created1"),
    recipientLabel: PATRecipientLabel.make("Automatización casa"),
    scopes: PATScopes.make(["read", "dashboard"]),
    lastUsedAt: Option.none(),
    idleExpiresAt: DateTime.addDuration(createdAt, "90 days"),
    revokedAt: Option.none(),
    createdAt,
  },
  bearer,
};

afterEach(cleanup);

const prepareGrantReview = (): void => {
  fireEvent.change(screen.getByLabelText("Nombre"), {
    target: { value: "  Automatización casa  " },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /Lectura/iu }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Tablero/iu }));
  fireEvent.click(screen.getByRole("button", { name: "Revisar PAT" }));
};

it("requires exact review, issues once, copies explicitly, and clears the revealed bearer", () => {
  const issue = vi.fn((command: IssueManualPATCommand) => {
    command.onIssued(issued);
  });
  const copyToClipboard = vi.fn();
  const clearClipboard = vi.fn();
  const { rerender } = render(
    <ManualPATView
      key="signed-in"
      clearClipboard={clearClipboard}
      copyToClipboard={copyToClipboard}
      issue={issue}
    />
  );

  prepareGrantReview();

  expect(screen.getByRole("heading", { name: "Revisa el acceso" })).toBeVisible();
  expect(screen.getByText("Automatización casa", { exact: true })).toBeVisible();
  expect(screen.getByText(/exactamente 90 días \(2\.160 horas\)/iu)).toBeVisible();
  expect(screen.queryByText(bearer)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Confirmar y crear PAT" }));

  expect(issue).toHaveBeenCalledWith(
    expect.objectContaining({
      grant: {
        recipientLabel: PATRecipientLabel.make("Automatización casa"),
        scopes: ["read", "dashboard"],
      },
    })
  );
  expect(issue.mock.calls[0]?.[0].requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
  expect(screen.getByRole("heading", { name: "Guarda este PAT ahora" })).toBeVisible();
  expect(screen.getByText(bearer)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Copiar PAT" }));
  expect(copyToClipboard).toHaveBeenCalledWith(bearer);

  rerender(
    <ManualPATView
      key="expired"
      clearClipboard={clearClipboard}
      copyToClipboard={copyToClipboard}
      issue={issue}
    />
  );
  expect(screen.queryByText(bearer)).not.toBeInTheDocument();
  expect(clearClipboard).toHaveBeenCalledWith(bearer);
});

it("edits a reviewed grant and preserves one request identity across a failed retry", () => {
  const issue = vi.fn<(command: IssueManualPATCommand) => void>();
  render(<ManualPATView clearClipboard={vi.fn()} copyToClipboard={vi.fn()} issue={issue} />);

  expect(screen.getByRole("button", { name: "Revisar PAT" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Nombre"), {
    target: { value: "x".repeat(recipientLabelLimit + 1) },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /Escritura/iu }));
  expect(screen.getByRole("button", { name: "Revisar PAT" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Robot" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Escritura/iu }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Escritura/iu }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Escritura/iu }));
  expect(screen.getByRole("button", { name: "Revisar PAT" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Escritura/iu }));
  fireEvent.click(screen.getByRole("button", { name: "Revisar PAT" }));
  fireEvent.click(screen.getByRole("button", { name: "Editar" }));
  expect(screen.getByLabelText("Nombre")).toHaveValue("Robot");

  fireEvent.click(screen.getByRole("button", { name: "Revisar PAT" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirmar y crear PAT" }));
  expect(screen.getByRole("button", { name: "Creando PAT…" })).toBeDisabled();
  const firstRequest = issue.mock.calls[0]?.[0];
  act(() => firstRequest?.onFailed());

  expect(screen.getByText("No pudimos crear el PAT")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Volver a la revisión" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirmar y crear PAT" }));
  expect(issue.mock.calls[1]?.[0].requestId).toBe(firstRequest?.requestId);
});

it("clears an issued bearer on reset and page hide", async () => {
  vi.useFakeTimers();
  const clearClipboard = vi.fn();
  const issue = vi.fn((command: IssueManualPATCommand) => command.onIssued(issued));
  render(<ManualPATView clearClipboard={clearClipboard} copyToClipboard={vi.fn()} issue={issue} />);

  prepareGrantReview();
  fireEvent.click(screen.getByRole("button", { name: "Confirmar y crear PAT" }));
  fireEvent.click(screen.getByRole("button", { name: "Crear otro PAT" }));
  expect(clearClipboard).toHaveBeenCalledWith(bearer);
  await vi.advanceTimersByTimeAsync(Duration.toMillis(bearerRevealLifetime));

  prepareGrantReview();
  fireEvent.click(screen.getByRole("button", { name: "Confirmar y crear PAT" }));
  act(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
  expect(screen.queryByText(bearer)).not.toBeInTheDocument();
  expect(clearClipboard).toHaveBeenLastCalledWith(bearer);
  vi.useRealTimers();
});
