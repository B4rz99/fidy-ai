import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateTime, Option } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  PATPairingId,
  type PATPairingReview,
  PATRecipientLabel,
  PATScopes,
} from "@/transport/client";
import {
  type ApprovePATPairingCommand,
  type InspectPATPairingCommand,
  PATPairingView,
} from "./pairing-view";

const review: PATPairingReview = {
  pairingId: PATPairingId.make("f1d1a000-0000-4000-8000-000000000249"),
  recipientLabel: PATRecipientLabel.make("Cliente de escritorio"),
  scopes: PATScopes.make(["read", "dashboard"]),
  lifetimeDays: 90,
  patExpiresAt: DateTime.makeUnsafe("2026-11-23T12:00:00.000Z"),
  claimBy: DateTime.makeUnsafe("2026-08-25T12:10:00.000Z"),
};

afterEach(cleanup);

it("submits a normalized public code and renders the immutable review", () => {
  const inspect = vi.fn((command: InspectPATPairingCommand) => command.onInspected(review));
  render(<PATPairingView approve={vi.fn()} inspect={inspect} />);
  expect(screen.getByRole("heading", { name: "Autorizar acceso con código" })).toBeVisible();
  expect(screen.getByText("Ingresa el código que aparece donde quieres usar Fidy.")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Código"), {
    target: { value: "  bcdf-ghjk  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }));

  expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ publicCode: "BCDF-GHJK" }));
  expect(screen.getByRole("heading", { name: "Confirma el acceso" })).toBeVisible();
  expect(screen.getByText("Nombre indicado")).toBeVisible();
  expect(screen.getByText("Cliente de escritorio")).toBeVisible();
  expect(screen.getByText("Permisos solicitados")).toBeVisible();
  expect(screen.getByText("Lectura")).toBeVisible();
  expect(screen.getByText("Tablero")).toBeVisible();
  expect(screen.getByText("90 días", { selector: "dd" })).toBeVisible();
  expect(screen.getByText("Acceso válido hasta")).toBeVisible();
  expect(screen.getByText(/23 de noviembre de 2026/iu)).toBeVisible();
  expect(screen.getByText("Completar la conexión antes de")).toBeVisible();
  expect(screen.getByText(/25 de agosto de 2026/iu)).toBeVisible();
});

it("approves only the inspected identity and exact expiration, then shows no credential", () => {
  const approve = vi.fn((command: ApprovePATPairingCommand) => command.onApproved());
  render(<PATPairingView approve={approve} inspect={(command) => command.onInspected(review)} />);
  fireEvent.change(screen.getByLabelText("Código"), {
    target: { value: "BCDF-GHJK" },
  });
  fireEvent.submit(screen.getByRole("button", { name: "Continuar" }));
  fireEvent.click(screen.getByRole("button", { name: "Autorizar acceso" }));

  expect(approve).toHaveBeenCalledWith(
    expect.objectContaining({ pairingId: review.pairingId, patExpiresAt: review.patExpiresAt })
  );
  expect(screen.getByText("Acceso autorizado")).toBeVisible();
  expect(screen.getByText(/vuelve al lugar donde obtuviste el código/iu)).toBeVisible();
  expect(
    screen.getByText(/este navegador no recibe ni muestra la clave de acceso/iu)
  ).toBeVisible();
  expect(document.body.textContent).not.toMatch(/fin_[A-Za-z0-9_]+/u);
  expect(screen.queryByRole("button", { name: /copiar/iu })).not.toBeInTheDocument();
});

it("disables duplicate approval and presents every failure generically", () => {
  let approval = Option.none<ApprovePATPairingCommand>();
  const { rerender } = render(
    <PATPairingView
      approve={(command) => {
        approval = Option.some(command);
      }}
      inspect={(command) => command.onInspected(review)}
    />
  );
  fireEvent.change(screen.getByLabelText("Código"), {
    target: { value: "BCDF-GHJK" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
  fireEvent.click(screen.getByRole("button", { name: "Autorizar acceso" }));
  expect(screen.getByRole("button", { name: "Autorizando…" })).toBeDisabled();
  act(() => Option.getOrThrow(approval).onFailed());
  expect(screen.getByText("No encontramos ese código")).toBeVisible();
  expect(screen.getByText(/no es válido o ya no está disponible/iu)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Ingresar otro código" }));
  expect(screen.getByLabelText("Código")).toHaveValue("");

  rerender(<PATPairingView approve={vi.fn()} inspect={(command) => command.onFailed()} />);
});
