import { DateTime, Effect, Schema } from "effect";
import {
  BrowserAcceptanceMode,
  type BrowserAcceptanceTopology,
  DashboardAssessmentConfiguration,
  browserAcceptanceTopologies,
} from "./contract";

/** Resolves only the broad fixture process's strict topology selection; this is not request-derived authority. */
export const browserAcceptanceTopology = (): BrowserAcceptanceTopology =>
  browserAcceptanceTopologies[
    Schema.decodeUnknownSync(BrowserAcceptanceMode)(Bun.env.CLI_ACCEPTANCE_MODE ?? "shared")
  ];

/** Fixed process configuration for isolated assessment setup, never request-derived authority. */
export const browserAssessmentConfiguration = (): typeof DashboardAssessmentConfiguration.Type =>
  Schema.decodeUnknownSync(DashboardAssessmentConfiguration)({
    dataset: Bun.env.FIDY_ASSESSMENT ?? "small",
    backend: Bun.env.FIDY_DASHBOARD_BACKEND ?? "legacy-d1",
    users: Number(Bun.env.FIDY_DASHBOARD_USERS ?? "1"),
    history: Bun.env.FIDY_DASHBOARD_HISTORY ?? "routine",
    layout: Bun.env.FIDY_DASHBOARD_LAYOUT ?? "default",
    activity: Bun.env.FIDY_DASHBOARD_ACTIVITY ?? "quiet",
    epoch: Bun.env.FIDY_ASSESSMENT_EPOCH ?? DateTime.formatIso(Effect.runSync(DateTime.now)),
  });
