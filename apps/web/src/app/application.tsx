import { RouterProvider } from "@tanstack/react-router";
import { Option } from "effect";
import { useState } from "react";
import type { JSX } from "react";
import { SessionRegistryProvider } from "@/session/session";
import { makeFidyClient, makeWebAuthClient } from "@/transport/client";
import { parseApiOrigin } from "@/transport/origin";
import { createWebRouter } from "./routes";

/** Composes the production browser application from Vite's validated API-origin configuration. */
export const WebApplication = (): JSX.Element => {
  const [router] = useState(() => {
    const apiOrigin = parseApiOrigin(import.meta.env.VITE_API_ORIGIN);
    return createWebRouter({
      apiClient: makeFidyClient(apiOrigin),
      webAuthClient: makeWebAuthClient(apiOrigin),
      history: Option.none(),
    });
  });

  return (
    <SessionRegistryProvider>
      <RouterProvider router={router} />
    </SessionRegistryProvider>
  );
};
