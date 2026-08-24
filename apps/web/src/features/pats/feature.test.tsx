import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateTime, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PATId, PATRecipientLabel, PATScopes, TokenBearer, TokenShortId } from "@/transport/client";
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

describe("manual PAT presentation", () => {
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

    fireEvent.change(screen.getByLabelText("Destinatario"), {
      target: { value: "  Automatización casa  " },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Lectura/iu }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Tablero/iu }));
    fireEvent.click(screen.getByRole("button", { name: "Revisar PAT" }));

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
});
