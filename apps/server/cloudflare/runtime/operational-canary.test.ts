import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { completeCanary, readCanaryHealth, receiveCanary } from "./operational-canary";

it("reports unexecuted Queue and Workflow canaries as unavailable, then separates their actual completions", async () => {
  const instance = new Miniflare({
    workers: [
      {
        config: {
          name: "canary",
          type: "worker",
          compatibilityDate: "2026-09-08",
          env: { DB: { id: "canary", type: "d1" } },
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
        "CREATE TABLE operational_canary (kind TEXT PRIMARY KEY, last_succeeded_ms INTEGER NOT NULL)"
      )
      .run();
    const now = Date.now();
    expect(await readCanaryHealth(db, now)).toEqual([
      { component: "capability", operation: "queueExecution", state: "unavailable" },
      { component: "capability", operation: "workflowExecution", state: "unavailable" },
    ]);
    const created: string[] = [];
    const workflow = {
      create: async (input: { id: string }): Promise<void> => {
        created.push(input.id);
      },
      get: async (): Promise<{ status: () => Promise<unknown> }> => ({
        status: async () => ({ status: "complete" }),
      }),
    };
    await expect(
      receiveCanary({ DB: db, workflow, now, payload: { version: 1, sentAtMs: "malformed" } })
    ).rejects.toThrow();
    expect(created).toEqual([]);
    await receiveCanary({ DB: db, workflow, now, payload: { version: 1, sentAtMs: now - 500 } });
    expect(created).toEqual([`operational-canary-${Math.floor((now - 500) / 300_000)}`]);
    expect(await readCanaryHealth(db, now)).toEqual([
      {
        component: "capability",
        operation: "queueExecution",
        state: "healthy",
        lastSucceededMs: now,
      },
      { component: "capability", operation: "workflowExecution", state: "unavailable" },
    ]);
    await completeCanary(db, { version: 1, sentAtMs: now }, now);
    expect((await readCanaryHealth(db, now))[1]).toEqual({
      component: "capability",
      operation: "workflowExecution",
      state: "healthy",
      lastSucceededMs: now,
    });
  } finally {
    await instance.dispose();
  }
});
