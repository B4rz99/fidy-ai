import { useCallback } from "react";
import { preloadDestinationCode } from "./destination-components";

/** Intent loads presentation code only. Data belongs to the actual destination visit. */
export const useNavigationPreparation = (): ((destination: string) => Promise<void>) =>
  useCallback(
    (destination: string) => preloadDestinationCode(destination).then(() => undefined),
    []
  );
