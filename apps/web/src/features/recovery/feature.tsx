import { Option } from "effect";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type JSX, type RefCallback, useCallback } from "react";
import { mountBackupRecovery } from "./program";

/** Mounts the scoped recovery program within the current application route. */
export const BackupRecoveryFeature = (): JSX.Element => {
  const router = useRouter();
  const apiClient = router.options.context.apiClient;
  const resources = useAtomValue(apiClient.runtime.layer);
  const mount = useCallback(
    (element: Parameters<RefCallback<HTMLDivElement>>[0]) =>
      element === null
        ? undefined
        : mountBackupRecovery({
            container: element,
            apiClient,
            resources,
            clipboard: Option.none(),
          }),
    [apiClient, resources]
  );
  return <div id="backup-recovery" ref={mount} />;
};
