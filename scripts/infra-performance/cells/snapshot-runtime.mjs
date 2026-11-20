// Two disposable, local-only D1 bindings shared by the frozen provider and the verifier.
import { Miniflare } from "miniflare";

export const snapshotRuntime = new Miniflare({
  workers: [
    {
      config: {
        type: "worker",
        name: "snapshot-probe",
        compatibilityDate: "2026-09-08",
        env: {
          ORACLE: { type: "d1", id: "migration-oracle" },
          RESTORED: { type: "d1", id: "snapshot-restore" },
        },
        manifest: {
          mainModule: "index.mjs",
          modules: {
            "index.mjs": {
              type: "esm",
              contents: "export default {fetch(){return new Response(null,{status:404})}}",
            },
          },
        },
      },
    },
  ],
});
