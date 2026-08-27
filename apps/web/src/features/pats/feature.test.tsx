import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateTime, Duration, Option } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  type ActivePATMetadata,
  type IssuedPAT,
  PATId,
  PATRecipientLabel,
  PATScopes,
  TokenBearer,
  TokenShortId,
  defaultPATLifetimeDays,
  patLifetimeDayOptions,
  recipientLabelLimit,
} from "@/transport/client";
import { bearerRevealLifetime } from "./policy";
import { type IssueManualPATCommand, ManualPATView } from "./view";
import {
  ActivePATManagementView,
  type RevokeActivePATCommand,
  type RevokeAllActivePATsCommand,
} from "./management-view";

const bearer = TokenBearer.make("fin_created1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const createdAt = DateTime.makeUnsafe("2026-08-10T12:00:00Z");
const issued: IssuedPAT = {
  pat: {
    _tag: "PAT" as const,
    id: PATId.make("f1d1a000-0000-4000-8000-000000000248"),
    shortId: TokenShortId.make("created1"),
    recipientLabel: PATRecipientLabel.make("Automatización casa"),
    scopes: PATScopes.make(["read", "dashboard"]),
    lifetimeDays: defaultPATLifetimeDays,
    lastUsedAt: Option.none(),
    expiresAt: DateTime.addDuration(createdAt, "90 days"),
    revokedAt: Option.none(),
    createdAt,
  },
  bearer,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const prepareGrantReview = (): void => {
  fireEvent.change(screen.getByLabelText("Nombre"), {
    target: { value: "  Automatización casa  " },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /Lectura/iu }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Tablero/iu }));
  fireEvent.click(screen.getByRole("button", { name: "Revisar token" }));
};

it("defaults to 90 days, reviews exact expiration, and issues the selected fixed lifetime", () => {
  vi.useFakeTimers();
  vi.setSystemTime(DateTime.toEpochMillis(createdAt));
  const issue = vi.fn((command: IssueManualPATCommand) => {
    command.onIssued(issued);
  });
  const copyToClipboard = vi.fn((_bearer: TokenBearer, onCopied: () => void) => onCopied());
  const clearClipboard = vi.fn();
  const { rerender } = render(
    <ManualPATView
      key="signed-in"
      clearClipboard={clearClipboard}
      copyToClipboard={copyToClipboard}
      issue={issue}
    />
  );

  expect(screen.getByRole("button", { name: "90 días" })).toHaveAttribute("aria-pressed", "true");
  prepareGrantReview();

  expect(screen.getByRole("heading", { name: "Revisa el acceso" })).toBeVisible();
  expect(screen.getByText("Automatización casa", { exact: true })).toBeVisible();
  expect(screen.getByText("90 días", { selector: "dd" })).toBeVisible();
  expect(screen.getByText(/8 de noviembre de 2026/iu)).toBeVisible();
  expect(screen.queryByText(bearer)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Confirmar y crear token" }));

  expect(issue).toHaveBeenCalledWith(
    expect.objectContaining({
      grant: {
        recipientLabel: PATRecipientLabel.make("Automatización casa"),
        scopes: ["read", "dashboard"],
        lifetimeDays: 90,
        reviewExpiresAt: issued.pat.expiresAt,
      },
    })
  );
  expect(issue.mock.calls[0]?.[0].requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
  expect(screen.getByText(bearer)).toBeVisible();
  expect(screen.queryByText("Se muestra una sola vez")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Copiar token" }));
  expect(copyToClipboard).toHaveBeenCalledWith(bearer, expect.any(Function));
  expect(screen.getByRole("button", { name: "Copiado" })).toBeVisible();

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
  vi.useRealTimers();
});

it("offers every fixed lifetime preset and preserves a changed selection through editing", () => {
  render(<ManualPATView clearClipboard={vi.fn()} copyToClipboard={vi.fn()} issue={vi.fn()} />);

  for (const days of patLifetimeDayOptions) {
    expect(screen.getByRole("button", { name: `${days} días` })).toBeVisible();
  }
  fireEvent.click(screen.getByRole("button", { name: "30 días" }));
  prepareGrantReview();
  expect(screen.getByText("30 días", { selector: "dd" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Editar" }));
  expect(screen.getByRole("button", { name: "30 días" })).toHaveAttribute("aria-pressed", "true");
});

it("edits a reviewed grant and preserves one request identity across a failed retry", () => {
  const issue = vi.fn<(command: IssueManualPATCommand) => void>();
  render(<ManualPATView clearClipboard={vi.fn()} copyToClipboard={vi.fn()} issue={issue} />);

  expect(screen.getByRole("button", { name: "Revisar token" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Nombre"), {
    target: { value: "x".repeat(recipientLabelLimit + 1) },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /Escritura/iu }));
  expect(screen.getByRole("button", { name: "Revisar token" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Robot" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Escritura/iu }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Escritura/iu }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Escritura/iu }));
  expect(screen.getByRole("button", { name: "Revisar token" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Escritura/iu }));
  fireEvent.click(screen.getByRole("button", { name: "Revisar token" }));
  fireEvent.click(screen.getByRole("button", { name: "Editar" }));
  expect(screen.getByLabelText("Nombre")).toHaveValue("Robot");

  fireEvent.click(screen.getByRole("button", { name: "Revisar token" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirmar y crear token" }));
  expect(screen.getByRole("button", { name: "Creando token…" })).toBeDisabled();
  const firstRequest = issue.mock.calls[0]?.[0];
  act(() => firstRequest?.onFailed());

  expect(screen.getByText("No pudimos crear el token")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Volver a la revisión" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirmar y crear token" }));
  expect(issue.mock.calls[1]?.[0].requestId).toBe(firstRequest?.requestId);
});

it("lists safe active metadata and confirms one revocation before refreshing", () => {
  const activePat: ActivePATMetadata = {
    shortId: TokenShortId.make("active01"),
    recipientLabel: PATRecipientLabel.make("Robot de reportes"),
    scopes: PATScopes.make(["read", "dashboard"]),
    createdAt,
    lastUsedAt: Option.some(DateTime.add(createdAt, { days: 1 })),
    expiresAt: DateTime.add(createdAt, { days: 90 }),
  };
  const revokeOne = vi.fn((command: RevokeActivePATCommand) => command.onRevoked());
  const revokeAll = vi.fn<(command: RevokeAllActivePATsCommand) => void>();
  const { rerender } = render(
    <ActivePATManagementView
      state={{ _tag: "Ready", result: { pats: [activePat] } }}
      revokeAll={revokeAll}
      revokeOne={revokeOne}
    />
  );

  expect(screen.getByRole("heading", { name: "PATs activos" })).toBeVisible();
  expect(screen.getByText("Robot de reportes")).toBeVisible();
  expect(screen.getByText("active01")).toBeVisible();
  expect(screen.getByText("read")).toBeVisible();
  expect(screen.getByText("dashboard")).toBeVisible();
  expect(screen.queryByText(bearer)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Revocar" }));
  expect(revokeOne).not.toHaveBeenCalled();
  expect(screen.getByText(/dejará de funcionar inmediatamente/iu)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Confirmar revocación" }));

  expect(revokeOne).toHaveBeenCalledWith(
    expect.objectContaining({ shortId: TokenShortId.make("active01") })
  );
  expect(screen.getByText(/acceso quedó deshabilitado inmediatamente/iu)).toBeVisible();
  rerender(
    <ActivePATManagementView
      state={{ _tag: "Ready", result: { pats: [] } }}
      revokeAll={revokeAll}
      revokeOne={revokeOne}
    />
  );
  expect(screen.getByText("No tienes PATs activos.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Revocar todos los PATs" })).toBeVisible();
});

it("confirms revoke-all and reports only the server's active PAT count", () => {
  const activePat: ActivePATMetadata = {
    shortId: TokenShortId.make("active02"),
    recipientLabel: PATRecipientLabel.make("Robot doméstico"),
    scopes: PATScopes.make(["write"]),
    createdAt,
    lastUsedAt: Option.none(),
    expiresAt: DateTime.add(createdAt, { days: 90 }),
  };
  const revokeAll = vi.fn((command: RevokeAllActivePATsCommand) => command.onRevoked(1));
  render(
    <ActivePATManagementView
      state={{ _tag: "Ready", result: { pats: [activePat] } }}
      revokeAll={revokeAll}
      revokeOne={vi.fn()}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Revocar todos los PATs" }));
  expect(revokeAll).not.toHaveBeenCalled();
  expect(screen.getByText(/aprobado que todavía no haya sido reclamado/iu)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Confirmar revocación total" }));

  expect(revokeAll).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Se revocó 1 PAT activo.")).toBeVisible();
});

it("clears an issued bearer on reset and page hide", async () => {
  vi.useFakeTimers();
  const clearClipboard = vi.fn();
  const issue = vi.fn((command: IssueManualPATCommand) => command.onIssued(issued));
  render(<ManualPATView clearClipboard={clearClipboard} copyToClipboard={vi.fn()} issue={issue} />);

  prepareGrantReview();
  fireEvent.click(screen.getByRole("button", { name: "Confirmar y crear token" }));
  fireEvent.click(screen.getByRole("button", { name: "Crear otro token" }));
  expect(clearClipboard).toHaveBeenCalledWith(bearer);
  await vi.advanceTimersByTimeAsync(Duration.toMillis(bearerRevealLifetime));

  prepareGrantReview();
  fireEvent.click(screen.getByRole("button", { name: "Confirmar y crear token" }));
  act(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
  expect(screen.queryByText(bearer)).not.toBeInTheDocument();
  expect(clearClipboard).toHaveBeenLastCalledWith(bearer);
  vi.useRealTimers();
});
