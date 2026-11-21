import type { NativeAcceptanceSettings } from "../contract";

type Settings = NativeAcceptanceSettings & Partial<Readonly<{ SQLITE_STORAGE_RELEASE: unknown }>>;

export const deploymentPhase = (
  settings: Settings
): "normal" | "open" | "closed" | "recovery" | "invalid" => {
  const admission = settings.NATIVE_STORAGE_ADMISSION,
    isolation = settings.RECOVERY_ISOLATION;

  if (admission === undefined && settings.SQLITE_STORAGE_RELEASE === undefined) {
    return isolation === "isolated" ? "recovery" : "normal";
  }

  if (admission === "closed" && isolation === "isolated") return "closed";

  if (admission === "open" && isolation === "") return "open";

  return "invalid";
};
