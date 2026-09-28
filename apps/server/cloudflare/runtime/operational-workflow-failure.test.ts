import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { captureWorkflowFailure } from "./operational-workflow-failure";

it("records a Workflow execution failure without changing its rejection or retaining its details", async () => {
  const instance = new Miniflare({
    workers: [
      {
        config: {
          name: "failed-workflow",
          type: "worker",
          compatibilityDate: "2026-09-08",
          env: { DB: { id: "failed-workflow", type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch() {return new Response('ok')}}",
                type: "esm",
              },
            },
          },
        },
      },
    ],
  });
  try {
    await instance.ready;
    const db = await instance.getD1Database("DB");
    await db
      .prepare(
        "CREATE TABLE operational_event_buckets (kind TEXT NOT NULL, bucket_ms INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (kind, bucket_ms))"
      )
      .run();
    const error = new Error("private user financial details");
    await expect(captureWorkflowFailure(Promise.reject(error), db)).rejects.toBe(error);
    expect(
      (await db.prepare("SELECT kind, count FROM operational_event_buckets").all()).results
    ).toEqual([{ kind: "workflow_failure", count: 1 }]);
  } finally {
    await instance.dispose();
  }
});
