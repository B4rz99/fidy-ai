import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateTime, Option, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { OAuthConnectionId, OAuthConnectionMetadata } from "@/transport/client";
import { OAuthManagementView } from "./management-view";

afterEach(cleanup);

it("keeps repeated claimed names distinct, renders safe activity and revokes the selected identity only", () => {
  const revoke = vi.fn();
  const first = OAuthConnectionId.make("10000000-0000-4000-8000-000000000001");
  const second = OAuthConnectionId.make("20000000-0000-4000-8000-000000000001");
  const connection = (connectionId: OAuthConnectionId): OAuthConnectionMetadata => ({
    connectionId,
    claimedClientName: "<img src=x onerror=alert(1)>",
    scopes: ["read"],
    permissions: [
      { scope: "read", label: "Consultar tus datos", description: "Consulta tus datos." },
    ],
    expiresAt: DateTime.makeUnsafe("2026-12-01T00:00:00Z"),
    state: "active",
    recentActivity: [],
  });
  const { container } = render(
    <OAuthManagementView
      list={{ connections: [connection(first), connection(second)], nextCursor: Option.none() }}
      busy={false}
      revoke={revoke}
      revokeAll={() => undefined}
      next={() => undefined}
    />
  );
  expect(screen.getAllByText("<img src=x onerror=alert(1)>")).toHaveLength(2);
  expect(container.querySelector("img")).toBeNull();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Revocar este agente" })[1] ?? screen.getByText("missing")
  );
  expect(revoke).toHaveBeenCalledWith(second);
  expect(screen.getByText(/no deshace acciones ya realizadas/)).toBeVisible();
  expect(screen.getByText(/tokens personales/)).toBeVisible();
});

it.each(["expired", "revoked"] as const)(
  "shows retained activity without offering revocation for %s connections",
  (state) => {
    const revokeAll = vi.fn();
    const next = vi.fn();
    const id = "10000000-0000-4000-8000-000000000001";
    const connection = Schema.decodeSync(OAuthConnectionMetadata)({
      connectionId: id,
      claimedClientName: "Agente",
      scopes: ["read"],
      permissions: [{ scope: "read", label: "Consultar", description: "Consultar datos" }],
      expiresAt: "2026-12-01T00:00:00Z",
      state,
      recentActivity: [
        {
          id,
          operation: "categories.listCategories",
          outcome: "succeeded",
          occurredAt: "2026-10-03T12:00:00Z",
        },
        {
          id: "20000000-0000-4000-8000-000000000001",
          operation: "categories.listCategories",
          outcome: "rejected",
          occurredAt: "2026-10-03T12:00:00Z",
        },
      ],
    });
    render(
      <OAuthManagementView
        list={{ connections: [connection], nextCursor: Option.some(connection.connectionId) }}
        busy={false}
        revoke={vi.fn()}
        revokeAll={revokeAll}
        next={next}
      />
    );
    expect(screen.queryByRole("button", { name: "Revocar este agente" })).not.toBeInTheDocument();
    expect(screen.getByText(/necesitas una nueva aprobación/)).toBeVisible();
    expect(screen.getAllByText("categories.listCategories")).toHaveLength(2);
    expect(screen.getByText(/Completada/)).toBeVisible();
    expect(screen.getByText(/Rechazada/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente página" }));
    expect(next).toHaveBeenCalledWith(connection.connectionId);
    fireEvent.click(screen.getByRole("button", { name: "Revocar todos los agentes conectados" }));
    expect(revokeAll).toHaveBeenCalledOnce();
  }
);
