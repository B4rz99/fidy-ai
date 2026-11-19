import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Miniflare } from "miniflare";
import { Schema } from "effect";
import type { FixtureClient, FixtureSession, RehearsalHooks } from "./bridge";

const rowCountsUrl = "https://offline.invalid/native-row-counts";
const halfMinute = 30_000;
const maximumChecks = 30;
const historySamples = 30;
const roles = ["UserStore", "Pricing", "Directory", "Erasure", "Maintenance"] as const;
const rowFields = [
  "statements",
  "rowsRead",
  "rowsWritten",
  "fetches",
  "alarms",
  "setAlarm",
  "getAlarm",
  "deleteAlarm",
  "deleteAll",
  "otherKv",
  "failedSql",
] as const;
const userResponse = Schema.Struct({
  data: Schema.Struct({ id: Schema.String.check(Schema.isUUID()) }),
});
const erasureResponse = Schema.Struct({
  reference: Schema.NonEmptyString,
  state: Schema.Literal("Draining"),
  next: Schema.Literal("admitted-work"),
});
const counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const counters = Schema.Record(Schema.String, Schema.Record(Schema.String, counter));
type Evidence = Record<string, unknown>;

const bound = (session: FixtureSession): Record<string, string> => ({
  cookie: session.cookie,
  "fidy-session-binding": session.binding,
});
const assert = (condition: boolean, message: string): void => {
  if (!condition) throw Error(message);
};
const identity = async (service: FixtureClient, session: FixtureSession): Promise<string> => {
  const response = await service.request(
    { method: "GET", path: "/user", body: null, control: "" },
    bound(session)
  );
  assert(response.status === 200, "Original synthetic identity unavailable");
  return Schema.decodeUnknownSync(userResponse)(await response.json()).data.id;
};

/** Read the physical experiment database from a separate, read-only connection. Never instantiate an erased object. */
const physicalCensus = async (
  runtime: Miniflare,
  directory: string
): Promise<Map<string, boolean>> => {
  const ids = await runtime.listDurableObjectIds("UserStore", "core");
  const result = new Map<string, boolean>();
  for (const id of ids) {
    assert(/^[0-9a-f]{64}$/u.test(id), "Unexpected physical User identity format");
    const paths = await Array.fromAsync(
      new Bun.Glob("**/" + id + ".sqlite").scan({ cwd: directory, absolute: true })
    );
    assert(paths.length === 1, "Ambiguous physical User storage");
    const file = new Database(paths[0], { readonly: true });
    try {
      result.set(
        id,
        file.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='users'").get() !== null
      );
    } finally {
      file.close();
    }
  }
  return result;
};

const observe = async (runtime: Miniflare): Promise<Evidence> => {
  const worker = await runtime.getWorker("core");
  const result = Schema.decodeUnknownSync(counters)(
    await (await worker.fetch(rowCountsUrl)).json()
  );
  for (const role of roles) {
    assert(
      rowFields.every((key) => typeof result[role]?.[key] === "number"),
      "Missing native cursor counters"
    );
  }
  const totals = Object.fromEntries(
    rowFields.map((key) => [key, roles.reduce((n, role) => n + result[role][key], 0)])
  );
  assert(totals.rowsRead > 0 && totals.rowsWritten > 0, "Native workerd row meter is empty");
  return { roles: result, totals };
};
const renew = async (service: FixtureClient): Promise<void> => {
  const reply = await service.request(
    {
      method: "POST",
      path: "/internal/release-smoke?acceptance=work",
      body: null,
      control: "unsigned",
    },
    { "x-fidy-smoke-proof": process.env.SMOKE_PROOF ?? "" }
  );
  assert(reply.status === 200, "Closed release did not admit background work");
  const lease = Schema.decodeUnknownSync(
    Schema.Struct({ revision: Schema.String, deadline: Schema.Int })
  )(await reply.json());
  assert(
    lease.revision === process.env.FIDY_NATIVE_REVISION && lease.deadline > Date.now(),
    "Closed lease differs"
  );
};

async function offerReads(service: FixtureClient, active: FixtureSession): Promise<void> {
  let first = "";
  for (let index = 0; index < historySamples; index++) {
    const read = await service.request(
      { method: "GET", path: "/transactions?limit=25", body: null, control: "" },
      bound(active)
    );
    assert(read.status === 200, "Complete HTTP history failed");
    const data = await read.text();
    if (index === 0) first = data;
    assert(data === first, "Canonical history changed during bounded reads");
    await Bun.sleep(700);
  }
}
const admit = async (service: FixtureClient, active: FixtureSession): Promise<string> => {
  const reply = await service.request(
    { method: "POST", path: "/web/privacy/erasure", body: { confirm: true }, control: "" },
    bound(active)
  );
  assert(reply.status === 202, "Exact synthetic User erasure refused");
  return Schema.decodeUnknownSync(erasureResponse)(await reply.json()).reference;
};
const unchanged = (before: Map<string, boolean>, current: Map<string, boolean>): boolean =>
  [...before].every(([name, populated]) => current.get(name) === populated);

export function calibrateNative(runtime: Miniflare, directory: string): RehearsalHooks {
  const phases: Evidence = { scope: "credential-free workerd", verified: false };
  const sample = async (stage: string): Promise<void> => {
    phases[stage] = await observe(runtime);
    await Bun.write(join(directory, "native-usage.json"), JSON.stringify(phases));
    process.stderr.write("Closed native sizing " + stage + "\n");
  };
  return async (service) => {
    const survivor = await service.bind(await service.login("performance-2"));
    const retained = await identity(service, survivor);
    const baseline = await physicalCensus(runtime, directory);
    assert([...baseline.values()].some(Boolean), "Independent survivor storage missing");
    await sample("survivorSetup");
    return async (active) => {
      const current = await physicalCensus(runtime, directory);
      const added = [...current].filter(([name, populated]) => !baseline.has(name) && populated);
      assert(
        unchanged(baseline, current) && added.length === 1 && current.size === baseline.size + 1,
        "Ambiguous fresh User object"
      );
      const target = added[0][0];
      assert((await identity(service, active)) !== retained, "Synthetic Users are not independent");
      await sample("signedFixture");
      await offerReads(service, active);
      await sample("offeredHistory");
      await renew(service);
      const reference = await admit(service, active);
      assert((await admit(service, active)) === reference, "Erasure replay mismatch");
      await sample("admittedErasure");
      let leaseCount = 1;
      for (let i = 0; i < maximumChecks; i++) {
        const objects = await physicalCensus(runtime, directory);
        assert(
          unchanged(baseline, objects) &&
            [...objects.keys()].every((name) => name === target || baseline.has(name)),
          "Survivor census changed"
        );
        if (objects.get(target) !== true) break;
        assert(i + 1 < maximumChecks, "Exact User remained physically populated at deadline");
        await renew(service);
        leaseCount++;
        // Deliver the same minute cron as the closed deployment. Real alarms keep their native deadlines.
        if (i % 2 === 0) {
          const core = await runtime.getWorker("core");
          await core.scheduled({ cron: "* * * * *", scheduledTime: new Date() });
        }
        await Bun.sleep(halfMinute);
        await sample("erasurePoll" + String(i + 1));
      }
      const denied = await service.request(
        { method: "GET", path: "/transactions?limit=25", body: null, control: "" },
        bound(active)
      );
      assert(denied.status === 401, "Erased Session was accepted");
      assert((await identity(service, survivor)) === retained, "Surviving User differs");
      phases.verification = {
        historySamples,
        leases: leaseCount,
        physicalSubjectEmptyOrAbsent: true,
        survivingUsers: 1,
        erasedSessionDenied: true,
        sameAdmission: true,
      };
      phases.verified = true;
      await sample("confirmedDisposal");
    };
  };
}
