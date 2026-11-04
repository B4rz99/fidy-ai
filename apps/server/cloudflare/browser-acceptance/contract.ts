import { Schema } from "effect";

export const BrowserAcceptanceMode = Schema.Literals(["shared", "cli", "oauth", "dashboard"]);
export type BrowserAcceptanceMode = typeof BrowserAcceptanceMode.Type;
export type BrowserAcceptanceTopology = Readonly<{
  mode: BrowserAcceptanceMode;
  app: string;
  api: string;
  operator: string;
  appPort: number;
  apiPort: number;
  operatorPort: number;
}>;
const topology = (mode: BrowserAcceptanceMode, appPort: number): BrowserAcceptanceTopology => ({
  mode,
  appPort,
  apiPort: appPort + 1,
  operatorPort: appPort + 2,
  app: `https://127.0.0.1:${appPort}`,
  api: `https://127.0.0.1:${appPort + 1}`,
  operator: `http://127.0.0.1:${appPort + 2}`,
});
const sharedAppPort = 4173;
const cliAppPort = 4183;
const oauthAppPort = 4193;
const dashboardAppPort = 4203;
/** Synthetic loopback identities owned by broad acceptance composition, never production authority. */
export const browserAcceptanceTopologies = {
  shared: topology("shared", sharedAppPort),
  cli: topology("cli", cliAppPort),
  oauth: topology("oauth", oauthAppPort),
  dashboard: topology("dashboard", dashboardAppPort),
} as const;

const moderateDashboardUsers = 8;
const maximumDashboardUsers = 32;
const uuidWidth = 12;
const identityStep = 10;
export const DashboardAssessmentDataset = Schema.Literals([
  "small",
  "heavy",
  "extreme",
  "breaking",
]);
export const DashboardAssessmentHistory = Schema.Literals([
  "routine",
  "dense",
  "wide",
  "reconciled",
  "recurring",
]);
export type DashboardAssessmentHistory = typeof DashboardAssessmentHistory.Type;
export const DashboardAssessmentLayout = Schema.Literals(["default", "maximum"]);
export const DashboardAssessmentConfiguration = Schema.Struct({
  dataset: DashboardAssessmentDataset,
  backend: Schema.Literals(["legacy-d1", "audited-native-guarded", "audited-native-qualified"]),
  users: Schema.Literals([1, moderateDashboardUsers, maximumDashboardUsers]),
  history: DashboardAssessmentHistory,
  layout: DashboardAssessmentLayout,
  activity: Schema.Literals(["quiet", "ingestion-two-tabs"]),
  epoch: Schema.DateTimeUtcFromString,
});

/** Fixed synthetic identities; an operator query cannot select an arbitrary User. */
export const dashboardAssessmentIdentities = [
  { key: "navigationDashboard", userId: "24000000-0000-4000-8000-000000000481" },
  ...Array.from({ length: maximumDashboardUsers - 1 }, (_, index) => ({
    key: `assessmentDashboard${index + 1}` as const,
    userId: `88000000-0000-4000-8000-${String((index + 1) * identityStep + 1).padStart(uuidWidth, "0")}`,
  })),
] as const;
