import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateTime, Option, Redacted } from "effect";
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
} from "@/transport/client";
import {
  type ActivePATManagementState,
  ActivePATManagementView,
  type RevokeActivePATCommand,
  type RevokeAllActivePATsCommand,
} from "./management-view";

const readyPATState = (
  pats: ReadonlyArray<ActivePATMetadata>
): Extract<ActivePATManagementState, { readonly _tag: "Ready" }> => ({
  _tag: "Ready",
  result: { pats },
  onRetry: () => undefined,
  refreshing: false,
  refreshFailed: false,
});

const bearer = TokenBearer.make("fin_created1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const redactedBearer = Redacted.make(bearer);
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
  bearer: redactedBearer,
};

afterEach(cleanup);
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
      state={readyPATState([activePat])}
      revokeAll={revokeAll}
      revokeOne={revokeOne}
    />
  );

  expect(screen.getByRole("heading", { name: "Tokens activos" })).toBeVisible();
  expect(screen.getByText("Robot de reportes")).toBeVisible();
  expect(screen.getByText("active01")).toBeVisible();
  expect(screen.getByText("Lectura")).toBeVisible();
  expect(screen.getByText("Tablero")).toBeVisible();
  expect(screen.queryByText(bearer)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Desactivar" }));
  expect(revokeOne).not.toHaveBeenCalled();
  expect(screen.getByText(/dejará de funcionar de inmediato/iu)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Sí, desactivar" }));

  expect(revokeOne).toHaveBeenCalledWith(
    expect.objectContaining({ shortId: TokenShortId.make("active01") })
  );
  expect(screen.getByText(/dejó de funcionar de inmediato/iu)).toBeVisible();
  rerender(
    <ActivePATManagementView
      state={readyPATState([])}
      revokeAll={revokeAll}
      revokeOne={revokeOne}
    />
  );
  expect(screen.getByText("No tienes tokens activos.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Desactivar todos los tokens" })).toBeVisible();
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
      state={readyPATState([activePat])}
      revokeAll={revokeAll}
      revokeOne={vi.fn()}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Desactivar todos los tokens" }));
  expect(revokeAll).not.toHaveBeenCalled();
  expect(screen.getByText(/tokens pendientes de activación/iu)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Sí, desactivar todos" }));

  expect(revokeAll).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Se desactivó 1 token activo.")).toBeVisible();
});

it("renders distinct idle, loading, and load-failure states", () => {
  const { rerender } = render(
    <ActivePATManagementView state={{ _tag: "Initial" }} revokeAll={vi.fn()} revokeOne={vi.fn()} />
  );
  expect(screen.getByText("La consulta de tokens aún no se ha iniciado.")).toBeVisible();

  rerender(
    <ActivePATManagementView state={{ _tag: "Loading" }} revokeAll={vi.fn()} revokeOne={vi.fn()} />
  );
  expect(screen.getByText("Cargando tokens activos…")).toBeVisible();
  rerender(
    <ActivePATManagementView
      state={{
        _tag: "LoadFailure",
        boundaryFailure: false,
        onRetry: () => undefined,
        waiting: false,
      }}
      revokeAll={vi.fn()}
      revokeOne={vi.fn()}
    />
  );
  expect(screen.getByText("No pudimos cargar tus tokens")).toBeVisible();
});

it("preserves active PAT metadata through refresh failure and retries the query", () => {
  const onRetry = vi.fn();
  render(
    <ActivePATManagementView
      state={{
        ...readyPATState([
          {
            shortId: TokenShortId.make("active04"),
            recipientLabel: PATRecipientLabel.make("Robot visible"),
            scopes: PATScopes.make(["read"]),
            createdAt,
            lastUsedAt: Option.none(),
            expiresAt: DateTime.add(createdAt, { days: 90 }),
          },
        ]),
        onRetry,
        refreshFailed: true,
      }}
      revokeAll={vi.fn()}
      revokeOne={vi.fn()}
    />
  );

  expect(screen.getByText("Robot visible")).toBeVisible();
  expect(screen.getByText("Mostramos los últimos tokens disponibles.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Desactivar" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Desactivar todos los tokens" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reintentar actualización" }));
  expect(onRetry).toHaveBeenCalledOnce();
});

it("blocks an already reviewed PAT revocation while its list refreshes", () => {
  const state = readyPATState([issued.pat]);
  const revokeOne = vi.fn();
  const revokeAll = vi.fn();
  const { rerender } = render(
    <ActivePATManagementView state={state} revokeOne={revokeOne} revokeAll={revokeAll} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Desactivar" }));
  rerender(
    <ActivePATManagementView
      state={{ ...state, refreshing: true }}
      revokeOne={revokeOne}
      revokeAll={revokeAll}
    />
  );
  expect(screen.getByRole("button", { name: "Sí, desactivar" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Sí, desactivar" }));
  expect(revokeOne).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Cancelar" })).toBeEnabled();
});

it("serializes revocation, allows cancellation, and reports failures and plural counts", () => {
  const activePat: ActivePATMetadata = {
    shortId: TokenShortId.make("active03"),
    recipientLabel: PATRecipientLabel.make("Robot de pruebas"),
    scopes: PATScopes.make(["read"]),
    createdAt,
    lastUsedAt: Option.none(),
    expiresAt: DateTime.add(createdAt, { days: 90 }),
  };
  const revokeOne = vi.fn<(command: RevokeActivePATCommand) => void>();
  const revokeAll = vi.fn<(command: RevokeAllActivePATsCommand) => void>();
  render(
    <ActivePATManagementView
      state={readyPATState([activePat])}
      revokeAll={revokeAll}
      revokeOne={revokeOne}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Desactivar" }));
  fireEvent.click(screen.getByRole("button", { name: "Sí, desactivar" }));
  expect(screen.getByRole("button", { name: "Desactivando…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Desactivar todos los tokens" })).toBeDisabled();

  act(() => revokeOne.mock.calls[0]?.[0].onFailed());
  expect(screen.getByText(/no pudimos desactivar el token/iu)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  expect(screen.queryByText(/no pudimos desactivar el token/iu)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Desactivar todos los tokens" }));
  fireEvent.click(screen.getByRole("button", { name: "Sí, desactivar todos" }));
  expect(screen.getByRole("button", { name: "Desactivando todos…" })).toBeDisabled();
  act(() => revokeAll.mock.calls[0]?.[0].onRevoked(2));
  expect(screen.getByText("Se desactivaron 2 tokens activos.")).toBeVisible();
});
