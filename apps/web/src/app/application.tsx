import { RouterProvider } from "@tanstack/react-router";
import { Option } from "effect";
import type { JSX } from "react";
import { SessionRegistryProvider } from "@/session/session";
import { makeFidyClient } from "@/transport/client";
import { parseApiOrigin } from "@/transport/origin";
import { createWebRouter } from "./routes";

/** Composes the production browser application from Vite's validated API-origin configuration. */
export const WebApplication = (): JSX.Element => {
  const apiClient = makeFidyClient(parseApiOrigin(import.meta.env.VITE_API_ORIGIN));
  const router = createWebRouter({ apiClient, history: Option.none() });

  return (
    <SessionRegistryProvider>
      <RouterProvider router={router} />
    </SessionRegistryProvider>
  );
};
