import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BackupRecoveryCode } from "@/transport/client";
import { BackupRecoveryRotationView, type RotateBackupRecoveryCommand } from "./feature";

const code = BackupRecoveryCode.make("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2");

afterEach(cleanup);

it("keeps disclosure only in one mounted view identity", () => {
  const rotate = vi.fn((command: RotateBackupRecoveryCommand) => command.onRotated(code));
  const copy = vi.fn();
  const { rerender, unmount } = render(
    <BackupRecoveryRotationView key="fresh" copy={copy} rotate={rotate} />
  );

  fireEvent.click(screen.getByRole("button", { name: "Crear un código nuevo" }));
  expect(screen.getByText(code)).toBeVisible();
  expect(screen.getByText(/guárdalo ahora/iu)).toBeVisible();
  expect(window.location.href).not.toContain(code);
  expect(JSON.stringify(window.history.state)).not.toContain(code);
  for (const storage of [window.localStorage, window.sessionStorage]) {
    const values = Array.from({ length: storage.length }, (_, index) =>
      storage.getItem(storage.key(index) ?? "")
    );
    expect(JSON.stringify(values)).not.toContain(code);
  }

  fireEvent.click(screen.getByRole("button", { name: "Copiar código" }));
  expect(copy).toHaveBeenCalledWith(code);

  rerender(<BackupRecoveryRotationView key="navigated" copy={copy} rotate={rotate} />);
  expect(screen.queryByText(code)).not.toBeInTheDocument();

  unmount();
  render(<BackupRecoveryRotationView copy={copy} rotate={rotate} />);
  expect(screen.queryByText(code)).not.toBeInTheDocument();
  expect(rotate).toHaveBeenCalledTimes(1);
});

it("shows a safe retry without retaining a code after rotation fails", () => {
  const rotate = vi.fn((command: RotateBackupRecoveryCommand) => command.onFailed());
  render(<BackupRecoveryRotationView copy={vi.fn()} rotate={rotate} />);

  fireEvent.click(screen.getByRole("button", { name: "Crear un código nuevo" }));

  expect(screen.getByText("No pudimos confirmar el código nuevo.")).toBeVisible();
  expect(screen.getByText(/Usa únicamente el último código que veas/u)).toBeVisible();
  expect(screen.getByRole("button", { name: "Intentar de nuevo" })).toBeVisible();
});
