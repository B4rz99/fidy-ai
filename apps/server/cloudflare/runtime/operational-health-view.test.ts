import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { recordOperationalHealth } from "./operational-health-view";

it("stores private, bounded capability evidence with its observation time, not a public health response", async () => {
  const instance = new Miniflare({
    workers: [
      {
        config: {
          name: "health-view",
          type: "worker",
          compatibilityDate: "2026-09-08",
          env: { DB: { id: "health-view", type: "d1" } },
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
        "CREATE TABLE operational_health_view (operation TEXT PRIMARY KEY, state TEXT NOT NULL, observed_at_ms INTEGER NOT NULL)"
      )
      .run();
    await recordOperationalHealth(
      db,
      [
        { component: "capability", operation: "d1", state: "healthy" },
        { component: "capability", operation: "providerConfig", state: "unavailable" },
      ],
      1_000_000
    );
    expect(
      (
        await db
          .prepare(
            "SELECT operation, state, observed_at_ms FROM operational_health_view ORDER BY operation"
          )
          .all()
      ).results
    ).toEqual([
      { operation: "d1", state: "healthy", observed_at_ms: 1_000_000 },
      { operation: "providerConfig", state: "unavailable", observed_at_ms: 1_000_000 },
    ]);
  } finally {
    await instance.dispose();
  }
});
