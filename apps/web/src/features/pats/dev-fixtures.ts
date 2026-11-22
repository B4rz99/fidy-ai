import { Schema } from "effect";
import { ActivePATList } from "@/transport/client";

export type PreviewDataset = "demo" | "worst" | "empty" | "one" | "many";

const manyRowCount = 25;

const labels = [
  "Token del agente de sincronización internacional familiar de respaldo",
  "AgenteResponsabilidadCivilProfesionalInternacionalRenovaciónAnual",
  "J",
  "・・の",
  "👨‍👩‍👧‍👦 Educación y cuidados familiares",
  "نور الهدى عبد الرحمن",
  "Agente <script> alert(1) </script> — renovación",
];

const scopeSets: ReadonlyArray<ReadonlyArray<"read" | "write" | "dashboard">> = [
  ["read", "write", "dashboard"],
  ["read"],
  ["read", "write"],
];

const defaultScopes = scopeSets[0] ?? ["read"];

const shortIdPadWidth = 5;

const shortIdLength = 8;

const unusedModulo = 4;

const expiringSoonModulo = 6;

const shortId = (index: number): string =>
  `dev${String(index).padStart(shortIdPadWidth, "0")}`.slice(0, shortIdLength);

type EncodedPAT = (typeof ActivePATList.Encoded)["pats"][number];

const makePAT = (index: number): EncodedPAT => ({
  shortId: shortId(index),
  recipientLabel: labels[index % labels.length] ?? "Agente",
  scopes: scopeSets[index % scopeSets.length] ?? defaultScopes,
  createdAt: "2026-08-01T10:00:00Z",
  lastUsedAt: index % unusedModulo === 0 ? null : "2026-11-14T18:30:00Z",
  expiresAt: index % expiringSoonModulo === 0 ? "2026-11-16T00:00:00Z" : "2027-02-01T10:00:00Z",
});

const itemCount = (dataset: PreviewDataset): number => {
  if (dataset === "empty") return 0;

  if (dataset === "one") return 1;

  return dataset === "many" ? manyRowCount : labels.length;
};

export const fixturePATs = ({
  list,
  dataset,
}: Readonly<{ list: ActivePATList; dataset: PreviewDataset }>): ActivePATList => {
  if (dataset === "demo") return list;

  return Schema.decodeSync(ActivePATList)({
    pats: Array.from({ length: itemCount(dataset) }, (_, index) => makePAT(index)),
  });
};
