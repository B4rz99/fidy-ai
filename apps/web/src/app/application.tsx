import { Option } from "effect";
import type { JSX } from "react";
import { parseApiOrigin } from "@/transport/origin";
import { createWebApplication } from "./create-application";

/** Composes the production browser application from Vite's validated API-origin configuration. */
export const WebApplication = (): JSX.Element =>
  createWebApplication({
    apiOrigin: parseApiOrigin(import.meta.env.VITE_API_ORIGIN),
    history: Option.none(),
  });
