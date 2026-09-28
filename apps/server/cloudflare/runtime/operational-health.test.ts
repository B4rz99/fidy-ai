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
      .prepare(
        "CREATE TABLE statement_staging_objects (id TEXT, expires_at_ms INTEGER, status TEXT, object_deleted_at_ms INTEGER)"
      )
      .run();
    await db
      .prepare(
        "CREATE TABLE statement_submissions (staging_id TEXT, retention_expires_at_ms INTEGER)"
      )
      .run();
    await db
      .prepare(
        "CREATE TABLE forwarded_email_receipts (id TEXT, received_at_ms INTEGER, expires_at_ms INTEGER, state TEXT)"
      )
      .run();
    await db.prepare("CREATE TABLE forwarded_email_outcomes (receipt_id TEXT)").run();
    await db
      .prepare(
        "CREATE TABLE statement_needs_review (evidence_expires_at_ms INTEGER, status TEXT, original_evidence TEXT, known_money TEXT)"
      )
      .run();
    const now = Date.now();
    await db
      .prepare("INSERT INTO statement_staging_objects VALUES ('pending', ?, 'pending', NULL)")
      .bind(now - 86_400_000)
      .run();
    await db
      .prepare("INSERT INTO statement_staging_objects VALUES ('published', ?, 'published', NULL)")
      .bind(now - 86_400_000)
      .run();
    await db
      .prepare("INSERT INTO statement_submissions VALUES ('published', ?)")
      .bind(now - 86_400_000)
      .run();
    await db
      .prepare("INSERT INTO forwarded_email_receipts VALUES (?, ?, ?, 'queued')")
      .bind("00000000-0000-4000-8000-000000000000", now - 600_000, now - 86_400_000)
      .run();
    await db
      .prepare(
        "INSERT INTO statement_needs_review VALUES (?, 'pending', 'private-financial-evidence', NULL)"
      )
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
      sampledOverdue: 4,
    });
    expect(JSON.stringify(signals)).not.toContain("private-financial-evidence");
    if (retention?.state === "attention" && retention.operation === "retention") {
      expect(retention.oldestOverdueAgeMilliseconds).toBeGreaterThanOrEqual(86_400_000);
    }
    expect(signals.find((signal) => signal.operation === "forwardedEmail")).toMatchObject({
      state: "attention",
      sampledPending: 1,
    });
    expect(signals.find((signal) => signal.operation === "billing")?.state).toBe("unavailable");
    expect(signals.find((signal) => signal.operation === "billingQueue")).toMatchObject({
      state: "attention",
      backlogCount: 150,
    });
  } finally {
    await instance.dispose();
  }
});
