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
    return runRecoveryOperation({
      environment: this.env,
      work: () => documentSnapshot({ request, environment: this.env }),
    }).catch(() => ({ kind: "refused", status: 503 }));
  }
}
