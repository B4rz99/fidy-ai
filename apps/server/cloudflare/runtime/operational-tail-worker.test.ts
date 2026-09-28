import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import tailWorker from "../operational-tail-worker";

it("persists only bounded event counters and a heartbeat without retaining request or exception data", async () => {
  const instance = new Miniflare({
    workers: [
      {
        config: {
          name: "operational-tail",
          type: "worker",
          compatibilityDate: "2026-09-08",
          env: { DB: { id: "operational-tail", type: "d1" } },
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
    const now = Date.now();
    await tailWorker.tail(
      [
        {
          outcome: "exception",
          eventTimestamp: now,
          exceptions: [{ message: "private-email@example.com" }],
        },
        {
          outcome: "ok",
          eventTimestamp: now,
          event: {
            request: {
              url: "https://api.fidyapp.com/providers/wompi/billing-events?userId=private",
            },
            response: { status: 401 },
          },
        },
        {
          outcome: "ok",
          eventTimestamp: now,
          event: {
            request: {
              url: "https://api.fidyapp.com/providers/wompi/billing-events?userId=private",
            },
            response: { status: 200 },
          },
        },
      ],
      { DB: db }
    );
    const rows = await db
      .prepare("SELECT kind, count FROM operational_event_buckets ORDER BY kind")
      .all();
    expect(rows.results).toEqual([
      { kind: "callback_rejection", count: 1 },
      { kind: "heartbeat", count: 1 },
      { kind: "worker_exception", count: 1 },
    ]);
    expect(JSON.stringify(rows.results)).not.toContain("private");
    await tailWorker.tail(
      Array.from({ length: 33 }, () => ({ outcome: "ok", eventTimestamp: now })),
      { DB: db }
    );
    expect(
      await db
        .prepare("SELECT kind FROM operational_event_buckets WHERE kind = 'tail_overflow'")
        .first()
    ).toEqual({ kind: "tail_overflow" });
  } finally {
    await instance.dispose();
  }
});
