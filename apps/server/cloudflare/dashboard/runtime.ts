import { Option } from "effect";
import { recoveryIsolationResponse } from "../release-isolation/operations";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { DashboardDocumentReply } from "../../src/shell/dashboard/contract";
import { runRecoveryOperation } from "../recovery-lifecycle/operations";
import type { DashboardDocumentEnvironment } from "./contract";
import { documentSnapshot } from "./internal/document";
import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";

export const makeDashboardErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));

/** The Web binding alone reaches document navigation; default Core fetch exposes no mode selector. */
export class DashboardDocumentService extends WorkerEntrypoint<DashboardDocumentEnvironment> {
  readDashboardDocument(request: Request): Promise<DashboardDocumentReply> {
    const isolated = recoveryIsolationResponse({
      request,
      environment: {
        mode: Option.fromUndefinedOr(this.env.RECOVERY_ISOLATION),
        proof: Option.fromUndefinedOr(this.env.SMOKE_PROOF),
      },
    });
    if (Option.isSome(isolated)) {
      return Promise.resolve({ kind: "refused", status: isolated.value.status });
    }
    return runRecoveryOperation({
      environment: this.env,
      work: () => documentSnapshot({ request, environment: this.env }),
    }).catch(() => ({ kind: "refused", status: 503 }));
  }
}
