import { it } from "@effect/vitest";
import { Clock, DateTime, Effect } from "effect";
import { afterAll, expect } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { receiveBrowserPairingEmail, receiveEmailReplacement } from "./runtime";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const id = "10000000-0000-4000-8000-000000000001";

const queueBatch = (body: unknown): MessageBatch<unknown> => ({
  queue: "proofs",
  metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
  ackAll: (): void => undefined,
  retryAll: (): void => undefined,
  messages: [
    {
      id: "delivery",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
      attempts: 1,
      body,
      ack: (): void => undefined,
      retry: (): void => undefined,
    },
  ],
});

const recordingWorkflow = (params: unknown[]): Workflow => ({
  create: (options): Promise<never> => {
    params.push(options?.params);
    return Promise.reject(new Error("Test creation stops after recording persisted params"));
  },
  get: (): Promise<never> => Promise.reject(new Error("Test has no existing instance")),
  createBatch: (): Promise<never> => Promise.reject(new Error("Unused test binding")),
  deleteBatch: (): Promise<never> => Promise.reject(new Error("Unused test binding")),
});

it.live("sanitizes both email proof Workflow params before native persistence", () =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "CREATE TABLE browser_pairing_email_proofs (work_id TEXT, email_address TEXT, expires_at_ms REAL, state TEXT)"
        )
        .run()
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "CREATE TABLE email_replacements (work_id TEXT, candidate_email TEXT, expires_at_ms REAL, state TEXT)"
        )
        .run()
    );
    for (const table of ["browser_pairing_email_proofs", "email_replacements"]) {
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?)`)
          .bind(id, "proof@example.test", now + 60_000, "awaiting_delivery")
          .run()
      );
    }
    const valid = {
      version: 1,
      traceId: "1".repeat(32),
      parentSpanId: "2".repeat(16),
      sampled: true,
      capturedAtUnixMilliseconds: now,
    };
    const contexts = [
      valid,
      { ...valid, credentials: "proof-body-secret-sentinel" },
      { ...valid, traceId: "private-credential-sentinel" },
      { ...valid, capturedAtUnixMilliseconds: now - 86_400_001 },
    ];
    for (const kind of ["browser-pairing-email", "email-replacement"] as const) {
      const params: unknown[] = [];
      const workflow = recordingWorkflow(params);
      for (const traceContext of contexts) {
        const batch = queueBatch({ kind, version: 1, id, traceContext });
        const delivery =
          kind === "browser-pairing-email"
            ? receiveBrowserPairingEmail({ DB: db, BROWSER_PAIRING_EMAIL_WORKFLOW: workflow })(
                batch
              )
            : receiveEmailReplacement({ DB: db, EMAIL_REPLACEMENT_WORKFLOW: workflow })(batch);
        yield* Effect.exit(delivery);
      }
      const identity = { kind, version: 1, id };
      expect(params).toEqual([{ ...identity, traceContext: valid }, identity, identity, identity]);
    }
  })
);
