import { Miniflare } from "miniflare";
import { Effect, Option } from "effect";
import { expect, it } from "vitest";
import { observeOperationalHealth } from "./operational-health";

it("reports expired statement staging separately when other background measurements are unavailable", async () => {
  const instance = new Miniflare({
    workers: [
      {
        config: {
          name: "retention-inspection",
          type: "worker",
          compatibilityDate: "2026-09-08",
          env: { DB: { id: "retention-inspection", type: "d1" } },
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
      .prepare("CREATE TABLE statement_staging_objects (expires_at_ms INTEGER, status TEXT)")
      .run();
    const now = Date.now();
    await db
      .prepare("INSERT INTO statement_staging_objects VALUES (?, 'pending')")
      .bind(now - 86_400_000)
      .run();
    const signals = await Effect.runPromise(
      observeOperationalHealth({
        DB: db,
        workflows: {},
        deadLetters: Option.none(),
        workQueues: {
          billingQueue: {
            metrics: () => Promise.resolve({ backlogCount: 150, backlogBytes: 3_000 }),
          },
        },
      })
    );
    const retention = signals.find((signal) => signal.operation === "retention");
    expect(retention).toMatchObject({
      operation: "retention",
      state: "attention",
      sampledOverdue: 1,
    });
    if (retention?.state === "attention" && retention.operation === "retention") {
      expect(retention.oldestOverdueAgeMilliseconds).toBeGreaterThanOrEqual(86_400_000);
    }
    expect(signals.find((signal) => signal.operation === "billing")?.state).toBe("unavailable");
    expect(signals.find((signal) => signal.operation === "billingQueue")).toMatchObject({
      state: "attention",
      backlogCount: 150,
    });
  } finally {
    await instance.dispose();
  }
});
