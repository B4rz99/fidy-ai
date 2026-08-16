import { RouterProvider } from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import type { Option } from "effect";
import type { JSX } from "react";
import { SessionRegistryProvider } from "@/session/session";
import { makeFidyClient } from "@/transport/client";
import { createWebRouter } from "./routes";

type WebApplicationOptions = Readonly<{
  readonly apiOrigin: string;
  readonly history: Option.Option<RouterHistory>;
}>;

/** Composes the browser transport, route tree, and authentication-lifetime registry. */
export const createWebApplication = (options: WebApplicationOptions): JSX.Element => {
  const apiClient = makeFidyClient(options.apiOrigin);
  const router = createWebRouter({ apiClient, history: options.history });

  return (
    <SessionRegistryProvider>
      <RouterProvider router={router} />
    </SessionRegistryProvider>
  );
};
