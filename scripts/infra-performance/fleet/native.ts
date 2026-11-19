import { BunFileSystem } from "@effect/platform-bun";
import { Clock, DateTime, Effect, FileSystem } from "effect";
import type { Miniflare } from "miniflare";
import {
  ownerCheckUrl,
  maintenanceName,
} from "../../../apps/server/cloudflare/maintenance/contract";
import {
  native,
  nativeFleetPlatform,
} from "../../../apps/server/cloudflare/user-store.test-fixture";

const count = Number(process.argv[2]);
if (count !== 36 && count !== 1000) throw new Error("Choose 36 or 1000 real User stores.");
const destination = `apps/server/test-results/2261-fleet/${count}`;
const minuteMs = 60_000;
const at = (number: number): string =>
  "22610000-0000-4000-8000-" + String(number).padStart(12, "0");
const refusingOwner = at(2);
const busyOwner = at(1);
const shared = ["directory-v1", "pricing", "erasure-registry-v1"];
const receiptKey = "a".repeat(64);

const write = Effect.fnUntraced(function* (event: object) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(destination + "/events.jsonl", JSON.stringify(event) + "\n", {
    flag: "a",
  });
});
const storage = (runtime: Miniflare, name: string) =>
  native(() => runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name }));
const prepare = Effect.fnUntraced(function* (runtime: Miniflare, name: string) {
  const ns = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
  const owner = ns.getByName(name);
  // Startup runs the full occupied User schema. A normal owner request subsequently performs
  // the lifetime registration and requires Maintenance's acknowledgement.
  const start = yield* native(() => owner.fetch(ownerCheckUrl, { method: "POST" }));
  if (start.status !== 204) return yield* Effect.die("Cannot initialize native User");
  const local = yield* storage(runtime, name);
  yield* native(() =>
    local.exec(
      "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0)",
      name
    )
  );
  const active = yield* native(() => owner.fetch(ownerCheckUrl, { method: "POST" }));
  if (active.status !== 204 || !active.headers.has("fidy-schema-version")) {
    return yield* Effect.die("Native User did not acknowledge a registered inspection");
  }
});
const seedWork = Effect.fnUntraced(function* (runtime: Miniflare) {
  const busy = yield* storage(runtime, busyOwner);
  yield* native(() =>
    busy.exec(
      "INSERT INTO canonical_request_receipts VALUES (?,?,'transactions.createTransaction',?,0,200,NULL)",
      busyOwner,
      receiptKey,
      "b".repeat(64)
    )
  );
  const refusing = yield* storage(runtime, refusingOwner);
  yield* native(() =>
    refusing.exec(
      "INSERT INTO erasure_requests(id,user_id,state) VALUES(?,?,'pending')",
      at(2000),
      refusingOwner
    )
  );
  yield* native(() =>
    refusing.exec("UPDATE users SET lifetime_registered=0 WHERE id=?", refusingOwner)
  );
});

const retainedReceipt = Effect.fnUntraced(function* (runtime: Miniflare) {
  const busy = yield* storage(runtime, busyOwner);
  return yield* native(() =>
    busy.exec(
      "SELECT retry_key_digest FROM canonical_request_receipts WHERE user_id=? AND retry_key_digest=?",
      busyOwner,
      receiptKey
    )
  );
});

const tick = Effect.fnUntraced(function* (runtime: Miniflare, slot: number, scheduled: number) {
  const core = yield* native(() => runtime.getWorker("core"));
  const owners = yield* native(() => runtime.getDurableObjectNamespace("MAINTENANCE", "core"));
  const maintenance = owners.getByName(maintenanceName);
  const registry = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Maintenance", { name: maintenanceName })
  );
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.sleep(Math.max(0, scheduled - now));
  const started = yield* Clock.currentTimeMillis;
  const deliver = () =>
    core.scheduled({
      cron: "* * * * *",
      scheduledTime: DateTime.toDate(DateTime.makeUnsafe(scheduled)),
    });
  const deliveries = yield* native(() =>
    Promise.all(slot === 2 ? [deliver(), deliver()] : [deliver()])
  );
  const finished = yield* Clock.currentTimeMillis;
  const [progress] = yield* native(() =>
    registry.exec(
      "SELECT scheduled,wraps,admitted,attempted,observed,failed,unsupported,unknown,repaired,shared_observed,halt FROM watchdog_progress"
    )
  );
  const transport = yield* native(() =>
    maintenance.fetch("https://fixture.invalid/fleet-observations").then((r) => r.json())
  );
  yield* write({
    phase: "tick",
    slot,
    scheduled,
    started,
    elapsedMs: finished - started,
    deliveries: deliveries.map((delivery) => delivery.outcome),
    progress,
    transport,
  });
});

const fleet = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(destination, { recursive: true });
  yield* fs.writeFileString(destination + "/events.jsonl", "");
  yield* write({
    phase: "plan",
    origin: "GitHub runner workerd loopback",
    revision: Bun.env.GITHUB_SHA,
    command: `bun scripts/infra-performance/fleet/native.ts ${count}`,
    users: count,
    slots: 10,
    minuteMs,
    setupConcurrency: 2,
    settings: {
      page: 32,
      usersPerTick: 256,
      shared: 3,
      concurrent: 5,
      probeMs: 1000,
      tickMs: 55000,
    },
    fixture:
      "Synthetic User rows in separate native databases, with production lifetime registration",
  });
  const create = yield* nativeFleetPlatform;
  const names = Array.from({ length: count - 1 }, (_, i) => at(i + 1));
  const start = yield* Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* create();
      for (let i = 0; i < names.length; i += 32) {
        const batch = names.slice(i, i + 32);
        yield* Effect.forEach(batch, (name) => prepare(runtime, name), {
          concurrency: 2,
          discard: true,
        });
        yield* write({
          phase: "prepared",
          users: i + batch.length,
          at: yield* Clock.currentTimeMillis,
        });
      }
      yield* seedWork(runtime);
      const registry = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("core", "Maintenance", { name: maintenanceName })
      );
      const registered = yield* native(() =>
        registry.exec("SELECT user_id FROM lifetime_registry WHERE retired=0 ORDER BY user_id")
      );
      if (
        registered.length !== names.length ||
        registered.some((row, i) => row["user_id"] !== names[i])
      ) {
        return yield* Effect.die("Prepared lifetime registry differs from the physical inventory");
      }
      const now = yield* Clock.currentTimeMillis;
      const start = Math.ceil(now / minuteMs) * minuteMs + 1000;
      yield* write({ phase: "inventory", start, owners: [...names, ...shared] });
      yield* tick(runtime, 0, start);
      // Bound the observed completion time separately from the watchdog's alarm-repaired response.
      const pollStarted = yield* Clock.currentTimeMillis;
      let receipt = yield* retainedReceipt(runtime);
      while (receipt.length > 0 && (yield* Clock.currentTimeMillis) - pollStarted < 5_000) {
        yield* Effect.sleep(100);
        receipt = yield* retainedReceipt(runtime);
      }
      yield* write({
        phase: "receipt",
        retained: receipt.length,
        inspectedAt: yield* Clock.currentTimeMillis,
      });
      const enrolled = yield* Clock.currentTimeMillis;
      yield* prepare(runtime, at(0));
      yield* write({ phase: "registered", name: at(0), at: enrolled });
      for (let slot = 1; slot < 5; slot++) yield* tick(runtime, slot, start + slot * minuteMs);
      return start;
    })
  );
  // Disposing the first workerd process clears all in-memory owner and observer state.
  const cold = yield* create();
  yield* write({ phase: "restart", at: yield* Clock.currentTimeMillis });
  for (let slot = 5; slot < 10; slot++) yield* tick(cold, slot, start + slot * minuteMs);
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.sleep(Math.max(0, start + 10 * minuteMs - now));
  const receipt = yield* retainedReceipt(cold);
  yield* write({
    phase: "complete",
    end: yield* Clock.currentTimeMillis,
    expiredReceiptsRemoved: Number(receipt.length === 0),
    refusingOwner,
  });
});

await Effect.runPromise(fleet.pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)));
