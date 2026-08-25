import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Option, Redacted } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EmailOnboardingViewState, emailVerificationResultState } from "./controller";
import { EmailOnboardingView } from "./feature";

const verify = vi.fn();
const acknowledge = vi.fn();
const restart = vi.fn();
const editing: EmailOnboardingViewState = { _tag: "Editing" };

const renderView = (state: EmailOnboardingViewState): void => {
  render(
    <EmailOnboardingView
      acknowledge={acknowledge}
      restart={restart}
      state={state}
      verify={verify}
    />
  );
};

afterEach(() => {
  cleanup();
  verify.mockReset();
  acknowledge.mockReset();
  restart.mockReset();
});

it("maps generic verification results without retaining the submitted proof", () => {
  expect(emailVerificationResultState(Option.none())).toEqual({ _tag: "Invalid" });
  expect(
    emailVerificationResultState(Option.some(Redacted.make("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2")))
  ).toEqual({
    _tag: "Recovery",
    backupRecoveryCode: "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2",
  });
});

describe("verified email onboarding", () => {
  it("submits the proof in one body field and clears it from React state", () => {
    renderView(editing);
    const input = screen.getByLabelText("Código de verificación");
    fireEvent.change(input, { target: { value: "abcd-2345-f7km-9q2d-x4pt-6rwc" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar y crear mi cuenta" }));

    expect(verify).toHaveBeenCalledWith("ABCD-2345-F7KM-9Q2D-X4PT-6RWC");
    expect(input).toHaveValue("");
  });

  it("shows one generic failure and restarts without retaining the submitted proof", () => {
    renderView({ _tag: "Invalid" });

    expect(screen.getByText("El código no es válido")).toBeVisible();
    expect(screen.getByText("Revisa el correo o solicita uno nuevo por WhatsApp.")).toBeVisible();
    expect(screen.getByLabelText("Código de verificación")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Empezar de nuevo" }));
    expect(restart).toHaveBeenCalledOnce();
  });

  it("loses the one-time recovery disclosure after a refresh", () => {
    renderView({
      _tag: "Recovery",
      backupRecoveryCode: "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2",
    });
    expect(screen.getByText("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2")).toBeVisible();

    cleanup();
    renderView(editing);
    expect(screen.queryByText("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Código de verificación")).toBeVisible();
  });
});

describe("verified email onboarding terminal states", () => {
  it("renders submission and acknowledged completion states", () => {
    renderView({ _tag: "Submitting" });
    expect(screen.getByRole("button", { name: "Verificando…" })).toBeDisabled();

    cleanup();
    renderView({ _tag: "Acknowledged" });
    expect(screen.getByText("Tu cuenta está lista")).toBeVisible();
    expect(screen.getByRole("link", { name: "Ir a iniciar sesión" })).toHaveAttribute(
      "href",
      "/auth/pair"
    );
  });

  it("requires simple acknowledgement of the one-time recovery disclosure", () => {
    renderView({
      _tag: "Recovery",
      backupRecoveryCode: "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2",
    });

    expect(screen.getByText("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Lo guardé" }));
    expect(acknowledge).toHaveBeenCalledOnce();
  });
});
