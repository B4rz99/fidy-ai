import { render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { EmailAddress } from "@/transport/client";
import { EmailReplacementView } from "./feature";

const renderView = (
  props: Parameters<typeof EmailReplacementView>[0]
): ReturnType<typeof render> => {
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/settings/email",
    component: () => <EmailReplacementView {...props} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/settings/email"] }),
  });
  return render(<RouterProvider router={router} />);
};

const candidateEmail = EmailAddress.make("new.mailbox@example.com");
const ignoreCommand = (): void => undefined;
const defaults = {
  request: ignoreCommand,
  complete: ignoreCommand,
  restart: ignoreCommand,
} as const;

describe("EmailReplacementView rendered states", () => {
  it("renders the pending request state", async () => {
    renderView({ ...defaults, state: { _tag: "Requesting" } });
    expect(await screen.findByText("Procesando…")).toBeInTheDocument();
  });

  it("renders an invalid-proof state without losing the candidate mailbox", async () => {
    renderView({
      ...defaults,
      state: { _tag: "Invalid", candidateEmail },
    });
    expect(await screen.findByText("El código no es válido")).toBeInTheDocument();
    expect(screen.getAllByText("Enviamos un código a new.mailbox@example.com.")).not.toHaveLength(
      0
    );
  });

  it("renders the completed replacement state", async () => {
    renderView({ ...defaults, state: { _tag: "Replaced" } });
    expect(await screen.findByText("Correo actualizado")).toBeInTheDocument();
  });

  it("directs stale sessions back through browser pairing", async () => {
    renderView({ ...defaults, state: { _tag: "FreshPairingRequired" } });
    expect(await screen.findByText("Vincula el navegador de nuevo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir a vinculación" })).toHaveAttribute(
      "href",
      "/auth/pair"
    );
  });
});
