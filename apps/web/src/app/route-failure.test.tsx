import {
  type AnyRoute,
  RouterProvider,
  createMemoryHistory,
  createRoute,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { Option } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeFidyClient, makeHostedTurnClient, makeWebAuthClient } from "@/transport/client";
import { createWebRouter } from "./routes";

vi.mock("@/features/public-site/feature", () => {
  return {
    createPublicSiteRoute: (parent: AnyRoute): AnyRoute =>
      createRoute({
        getParentRoute: () => parent,
        path: "/",
        component: () => {
          throw new Error("private request URL and credentials");
        },
      }),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("offers page reload after a route fails without exposing the original error", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const apiOrigin = "https://api.fidy.test";
  const router = createWebRouter({
    apiClient: makeFidyClient({ apiOrigin }),
    hostedTurnClient: makeHostedTurnClient({ apiOrigin }),
    webAuthClient: makeWebAuthClient({ apiOrigin }),
    history: Option.some(createMemoryHistory({ initialEntries: ["/"] })),
  });
  render(<RouterProvider router={router} />);
  return screen.findByRole("alert").then((alert) => {
    expect(alert).toHaveTextContent("No pudimos cargar esta página");
    expect(screen.getByRole("button", { name: "Recargar página" })).toBeVisible();
    expect(screen.queryByText(/private request/)).toBeNull();
    expect(screen.queryByRole("button", { name: /show error/i })).toBeNull();
  });
});
