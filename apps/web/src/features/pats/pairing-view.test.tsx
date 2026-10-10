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
  claimBy: DateTime.makeUnsafe("2026-08-25T12:10:00.000Z"),
};

afterEach(cleanup);

it("submits a normalized public code and renders the immutable review", () => {
  const inspect = vi.fn((command: InspectPATPairingCommand) => command.onInspected(review));
  render(
    <PATPairingView
      initialReview={Option.none()}
      publicCode={Option.none()}
      approve={vi.fn()}
      inspect={inspect}
    />
  );
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
  expect(screen.getByText("Vigencia desde la autorización")).toBeVisible();
  expect(screen.getByText("Completar la conexión antes de")).toBeVisible();
  expect(screen.getByText(/25 de agosto de 2026/iu)).toBeVisible();
});

it("reviews and approves a client-selected seven-day pairing starting at approval", () => {
  const sevenDays: PATPairingReview = {
    ...review,
    lifetimeDays: 7,
  };
  const approve = vi.fn((command: ApprovePATPairingCommand) => command.onApproved());
  render(
    <PATPairingView
      initialReview={Option.none()}
      publicCode={Option.none()}
      approve={approve}
      inspect={(command) => command.onInspected(sevenDays)}
    />
  );
  fireEvent.change(screen.getByLabelText("Código"), { target: { value: "BCDF-GHJK" } });
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
  expect(screen.getByText("7 días", { selector: "dd" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Autorizar acceso" }));
  expect(approve).toHaveBeenCalledWith(
    expect.objectContaining({
      pairingId: sevenDays.pairingId,
    })
  );
});

it("approves only the inspected identity and fixed lifetime, then shows no credential", () => {
  const approve = vi.fn((command: ApprovePATPairingCommand) => command.onApproved());
  render(
    <PATPairingView
      initialReview={Option.none()}
      publicCode={Option.none()}
      approve={approve}
      inspect={(command) => command.onInspected(review)}
    />
  );
  fireEvent.change(screen.getByLabelText("Código"), {
    target: { value: "BCDF-GHJK" },
  });
  fireEvent.submit(screen.getByRole("button", { name: "Continuar" }));
  fireEvent.click(screen.getByRole("button", { name: "Autorizar acceso" }));

  expect(approve).toHaveBeenCalledWith(expect.objectContaining({ pairingId: review.pairingId }));
  expect(screen.getByText("Acceso autorizado")).toBeVisible();
  expect(screen.getByText(/volver a la terminal/iu)).toBeVisible();
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
      initialReview={Option.none()}
      publicCode={Option.none()}
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

  rerender(
    <PATPairingView
      initialReview={Option.none()}
      publicCode={Option.none()}
      approve={vi.fn()}
      inspect={(command) => command.onFailed()}
    />
  );
});

it("preselects the public request without approving it and requires a deliberate confirmation", () => {
  const approve = vi.fn((command: ApprovePATPairingCommand) => command.onApproved());
  const inspect = vi.fn();
  render(
    <PATPairingView
      initialReview={Option.some(review)}
      publicCode={Option.some("BCDF-GHJK")}
      approve={approve}
      inspect={inspect}
    />
  );
  expect(screen.getByText("BCDF-GHJK")).toBeVisible();
  expect(screen.getByText(/no verifica su identidad/u)).toBeVisible();
  expect(approve).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Autorizar acceso" }));
  expect(approve).toHaveBeenCalledTimes(1);
  expect(approve).toHaveBeenCalledWith(expect.objectContaining({ pairingId: review.pairingId }));
});

it("does not place an invalid or secret-like pasted code in a sign-in URL", () => {
  const approve = vi.fn();
  render(
    <PATPairingView
      initialReview={Option.none()}
      publicCode={Option.none()}
      approve={approve}
      inspect={(command) => command.onFailed()}
    />
  );
  fireEvent.change(screen.getByLabelText("Código"), { target: { value: "private-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
  expect(screen.getByText("No encontramos ese código")).toBeVisible();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(approve).not.toHaveBeenCalled();
});

it("binds the comparison code to the new review after cancelling a preselected request", () => {
  const replacement: PATPairingReview = {
    ...review,
    pairingId: PATPairingId.make("f1d1a000-0000-4000-8000-000000000250"),
    recipientLabel: PATRecipientLabel.make("Otro cliente"),
  };
  const approve = vi.fn();
  render(
    <PATPairingView
      initialReview={Option.some(review)}
      publicCode={Option.some("BCDF-GHJK")}
      approve={approve}
      inspect={(command) => command.onInspected(replacement)}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  fireEvent.change(screen.getByLabelText("Código"), { target: { value: "LMNP-QRST" } });
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
  expect(screen.getByText("LMNP-QRST")).toBeVisible();
  expect(screen.queryByText("BCDF-GHJK")).not.toBeInTheDocument();
  expect(screen.getByText("Otro cliente")).toBeVisible();
  expect(approve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Autorizar acceso" }));
  expect(approve).toHaveBeenCalledWith(
    expect.objectContaining({ pairingId: replacement.pairingId })
  );
});
