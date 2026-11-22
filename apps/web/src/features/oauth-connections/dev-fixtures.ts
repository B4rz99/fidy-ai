import { Schema } from "effect";
import { OAuthConnectionList } from "@/transport/client";

export type PreviewDataset = "demo" | "worst" | "empty" | "one" | "many";

const manyRowCount = 25;

const uuidSuffixLength = 12;

const uid = (index: number): string =>
  `77000000-0000-4000-8000-${String(index + 1).padStart(uuidSuffixLength, "0")}`;

type ConnectionState = "active" | "expired" | "revoked";

type ConnectionOutcome = "succeeded" | "rejected" | "failed";

const names = [
  "Codex CLI — estación de trabajo internacional de respaldo familiar con sincronización continua",
  "AgenteResponsabilidadCivilProfesionalInternacionalRenovaciónAnual",
  "J",
  "・エージェント",
  "🏦 Agente familiar",
  "نور الهدى عبد الرحمن",
];

const scopes: ReadonlyArray<ReadonlyArray<"read" | "write" | "dashboard">> = [
  ["read", "write", "dashboard"],
  ["read"],
  ["read", "write"],
];

const permissions = [
  {
    scope: "read",
    label: "Consultar información",
    description: "El agente puede consultar tus datos",
  },
] as const;

const expiredModulo = 5;

const revokedModulo = 7;

const nextCursorIndex = 50;

const stateFor = (index: number): ConnectionState => {
  if (index % expiredModulo === expiredModulo - 1) return "expired";

  return index % revokedModulo === revokedModulo - 1 ? "revoked" : "active";
};

const activityFor = (
  index: number
): ReadonlyArray<
  Readonly<{
    id: string;
    operation: string;
    outcome: ConnectionOutcome;
    occurredAt: string;
  }>
> =>
  index % 2 === 0
    ? [
        {
          id: uid(index + 100),
          operation: "ingestion.submit",
          outcome: index % 4 === 0 ? "failed" : "succeeded",
          occurredAt: "2026-11-14T18:30:00Z",
        },
      ]
    : [];

type EncodedConnection = (typeof OAuthConnectionList.Encoded)["connections"][number];

const makeConnection = (index: number): EncodedConnection => ({
  connectionId: uid(index),
  claimedClientName: names[index % names.length] ?? "Agente",
  scopes: scopes[index % scopes.length] ?? ["read"],
  permissions,
  expiresAt: "2027-02-01T10:00:00Z",
  state: stateFor(index),
  recentActivity: activityFor(index),
});

const itemCount = (dataset: PreviewDataset): number => {
  if (dataset === "empty") return 0;

  if (dataset === "one") return 1;

  return dataset === "many" ? manyRowCount : names.length;
};

export const fixtureConnections = ({
  list,
  dataset,
}: Readonly<{ list: OAuthConnectionList; dataset: PreviewDataset }>): OAuthConnectionList => {
  if (dataset === "demo") return list;

  return Schema.decodeSync(OAuthConnectionList)({
    connections: Array.from({ length: itemCount(dataset) }, (_, index) => makeConnection(index)),
    nextCursor: dataset === "many" ? uid(nextCursorIndex) : null,
  });
};
