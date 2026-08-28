import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { rotateBackupRecoveryCode } from "./service";

/** Serves one-time BackupRecoveryCode rotation through canonical fresh-WebSession authority. */
export const RecoveryLive = HttpApiBuilder.group(FidyApi, "recovery", (handlers) =>
  handlers.handle("rotateBackupRecoveryCode", () =>
    Effect.gen(function* () {
      const caller = yield* ResolvedCaller;
      if (caller.auditCaller._tag !== "WebSession") {
        return yield* Effect.die("Fresh-WebSession operation reached without WebSession authority");
      }
      return {
        data: yield* rotateBackupRecoveryCode(
          caller.subjectUserId,
          caller.auditCaller.webSessionId
        ),
        next: [],
      };
    })
  )
);
