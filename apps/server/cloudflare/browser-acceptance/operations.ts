import { Schema } from "effect";
import {
  BrowserAcceptanceMode,
  type BrowserAcceptanceTopology,
  browserAcceptanceTopologies,
} from "./contract";

/** Resolves only the broad fixture process's strict topology selection; this is not request-derived authority. */
export const browserAcceptanceTopology = (): BrowserAcceptanceTopology =>
  browserAcceptanceTopologies[
    Schema.decodeUnknownSync(BrowserAcceptanceMode)(Bun.env.CLI_ACCEPTANCE_MODE ?? "shared")
  ];
